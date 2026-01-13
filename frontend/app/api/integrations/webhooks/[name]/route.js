// app/api/webhooks/[name]/route.ts
import Stripe from "stripe";
import { headers } from "next/headers";
import { getServiceSupabase } from "../../../../../lib/supabase/serverClients";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Required env vars:
 * - STRIPE_SECRET_KEY
 * - STRIPE_WEBHOOK_SECRET   (the signing secret for THIS endpoint)
 *
 * Your checkout session MUST include metadata:
 * - analysis_id
 * - tier ("basic" | "pro")
 */

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function safeStr(v: any, max = 200) {
  if (typeof v !== "string") return "";
  const s = v.trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max) : s;
}

function normalizeTier(v: any): "basic" | "pro" {
  const t = safeStr(v, 20).toLowerCase();
  return t === "pro" ? "pro" : "basic";
}

async function tryStoreEvent(supabase: any, event: Stripe.Event, name: string) {
  // Optional: if you have a table for idempotency.
  // Table suggestion:
  // create table public.webhook_events (
  //   id text primary key,
  //   provider text not null,
  //   type text not null,
  //   created_at timestamptz default now(),
  //   payload jsonb
  // );
  try {
    await supabase.from("webhook_events").insert({
      id: event.id,
      provider: name,
      type: event.type,
      payload: event as any,
    });
    return { stored: true, already: false };
  } catch (e: any) {
    // If the table doesn't exist OR duplicate key, we just proceed.
    const msg = String(e?.message || "");
    if (msg.toLowerCase().includes("duplicate")) return { stored: false, already: true };
    return { stored: false, already: false };
  }
}

async function markAnalysisPaid(input: {
  supabase: any;
  analysisId: string;
  tier: "basic" | "pro";
  eventId: string;
  sessionId?: string | null;
  paymentIntentId?: string | null;
  customerId?: string | null;
}) {
  const { supabase, analysisId, tier, eventId, sessionId, paymentIntentId, customerId } = input;

  // Load existing meta so we merge instead of overwriting
  const { data: row, error: readErr } = await supabase
    .from("analyses")
    .select("id, meta, status")
    .eq("id", analysisId)
    .maybeSingle();

  if (readErr) throw new Error(readErr.message);
  if (!row) throw new Error(`Analysis not found: ${analysisId}`);

  const curMeta = (row as any).meta || {};
  const nextMeta = {
    ...curMeta,
    paid: true,
    tier,
    paid_at: new Date().toISOString(),
    stripe: {
      ...(curMeta?.stripe || {}),
      last_event_id: eventId,
      session_id: sessionId || curMeta?.stripe?.session_id || null,
      payment_intent_id: paymentIntentId || curMeta?.stripe?.payment_intent_id || null,
      customer_id: customerId || curMeta?.stripe?.customer_id || null,
    },
  };

  // If you want: bump status so UI looks nicer
  // (execute route will run and set done)
  const nextStatus =
    row.status === "pending" || row.status === "running" ? row.status : "pending";

  const { error: upErr } = await supabase
    .from("analyses")
    .update({
      meta: nextMeta,
      status: nextStatus,
      error: null,
    })
    .eq("id", analysisId);

  if (upErr) throw new Error(upErr.message);
}

export async function POST(req: Request, { params }: { params: { name: string } }) {
  const name = safeStr(params?.name, 50) || "unknown";

  // Only Stripe in this handler
  if (name !== "stripe") {
    const body = await req.text().catch(() => "");
    return new Response(JSON.stringify({ ok: true, webhook: name, received: true, length: body.length }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = getServiceSupabase();

  // Stripe signature verification requires the RAW body string
  const rawBody = await req.text();
  const sig = headers().get("stripe-signature") || "";

  let event: Stripe.Event;
  try {
    const stripe = new Stripe(mustEnv("STRIPE_SECRET_KEY"));
    event = stripe.webhooks.constructEvent(rawBody, sig, mustEnv("STRIPE_WEBHOOK_SECRET"));
  } catch (err: any) {
    return new Response(JSON.stringify({ ok: false, error: "Invalid signature", detail: err?.message || String(err) }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Optional event storage/idempotency (safe to ignore if table missing)
  const stored = await tryStoreEvent(supabase, event, name);

  // If you *do* store events and we already saw it, safely ACK.
  if (stored.already) {
    return new Response(JSON.stringify({ ok: true, received: true, idempotent: true, event: event.id }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    // We care about one-time payment checkout sessions (mode: "payment")
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;

      const analysisId = safeStr((session.metadata as any)?.analysis_id, 80);
      const tier = normalizeTier((session.metadata as any)?.tier);

      // If session doesn't include metadata, we cannot link it.
      if (analysisId) {
        await markAnalysisPaid({
          supabase,
          analysisId,
          tier,
          eventId: event.id,
          sessionId: session.id,
          paymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : null,
          customerId: typeof session.customer === "string" ? session.customer : null,
        });
      }

      return new Response(
        JSON.stringify({
          ok: true,
          received: true,
          event: event.id,
          type: event.type,
          analysisId: analysisId || null,
          tier,
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // Fallback: sometimes you may want to handle payment_intent.succeeded too,
    // but it usually does NOT include your metadata unless you add it.
    if (event.type === "payment_intent.succeeded") {
      return new Response(JSON.stringify({ ok: true, received: true, event: event.id, type: event.type }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Ignore other Stripe events but ACK them
    return new Response(JSON.stringify({ ok: true, received: true, event: event.id, type: event.type }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: any) {
    // Stripe will retry if we return non-2xx. If this is a transient DB issue,
    // you may want to return 500 so it retries.
    return new Response(JSON.stringify({ ok: false, error: e?.message || String(e), event: event.id, type: event.type }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}