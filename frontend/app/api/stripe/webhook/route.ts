// frontend/app/api/stripe/webhook/route.ts
import { NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stripe webhooks MUST read the raw body for signature verification.
 * Do NOT call req.json().
 */

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function json(status: number, payload: any) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function supabaseAdmin() {
  return createClient(
    mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
    mustEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } }
  );
}

function normalizeTier(v: any): "basic" | "pro" {
  const s = String(v || "").toLowerCase().trim();
  return s === "pro" ? "pro" : "basic";
}

function pickAnalysisId(session: Stripe.Checkout.Session) {
  const meta: any = session.metadata || {};
  const a =
    String(meta.analysis_id || meta.analysisId || "").trim() ||
    String(session.client_reference_id || "").trim();
  return a || "";
}

function pickTier(session: Stripe.Checkout.Session): "basic" | "pro" {
  const meta: any = session.metadata || {};
  return normalizeTier(meta.tier || meta.plan || meta.level);
}

export async function POST(req: Request) {
  const stripe = new Stripe(mustEnv("STRIPE_SECRET_KEY"));

  try {
    const sig = req.headers.get("stripe-signature");
    if (!sig) return json(400, { ok: false, error: "Missing stripe-signature header" });

    // Raw body
    const raw = await req.arrayBuffer();
    const buf = Buffer.from(raw);

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(buf, sig, mustEnv("STRIPE_WEBHOOK_SECRET"));
    } catch (err: any) {
      return json(400, {
        ok: false,
        error: `Webhook signature verification failed: ${err?.message || String(err)}`,
      });
    }

    // We care about the checkout finishing successfully.
    const supported = new Set([
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
    ]);

    if (!supported.has(event.type)) {
      return json(200, { ok: true, handled: false, type: event.type });
    }

    const session = event.data.object as Stripe.Checkout.Session;

    const analysisId = pickAnalysisId(session);
    const tier = pickTier(session);

    // Always ACK to avoid Stripe infinite retries if metadata is missing.
    if (!analysisId) {
      return json(200, {
        ok: true,
        handled: true,
        warning: "No analysis_id found in session metadata or client_reference_id",
        eventId: event.id,
        type: event.type,
      });
    }

    const admin = supabaseAdmin();

    // Load current meta
    const { data: row, error: readErr } = await admin
      .from("analyses")
      .select("meta")
      .eq("id", analysisId)
      .single();

    if (readErr) {
      return json(200, {
        ok: true,
        handled: true,
        analysisId,
        warning: readErr.message,
        eventId: event.id,
      });
    }

    const meta = (row?.meta || {}) as any;

    // Idempotent: if already paid, just ACK.
    // If paid but tier is basic and session tier is pro, allow upgrade.
    const alreadyPaid = meta?.paid === true;
    const currentTier = normalizeTier(meta?.tier || meta?.executed_tier);

    const shouldUpgrade = alreadyPaid && currentTier === "basic" && tier === "pro";
    if (alreadyPaid && !shouldUpgrade) {
      return json(200, { ok: true, handled: true, analysisId, alreadyPaid: true, eventId: event.id });
    }

    const nextMeta = {
      ...meta,
      paid: true,
      tier,
      executed_tier: tier,
      exportAllowed: tier === "pro",
      stripe: {
        ...(meta?.stripe || {}),
        last_event_id: event.id,
        last_event_type: event.type,
        checkout_session_id: session.id,
        payment_intent: typeof session.payment_intent === "string" ? session.payment_intent : null,
        customer: typeof session.customer === "string" ? session.customer : null,
        amount_total: session.amount_total ?? null,
        currency: session.currency ?? null,
        paid_at: new Date().toISOString(),
      },
    };

    const { error: updErr } = await admin
      .from("analyses")
      .update({ meta: nextMeta })
      .eq("id", analysisId);

    if (updErr) {
      return json(200, { ok: true, handled: true, analysisId, warning: updErr.message, eventId: event.id });
    }

    return json(200, {
      ok: true,
      handled: true,
      analysisId,
      tier,
      upgraded: shouldUpgrade || false,
      eventId: event.id,
    });
  } catch (e: any) {
    // Return 500 so Stripe retries if something truly unexpected happened.
    return json(500, { ok: false, error: e?.message || String(e) });
  }
}
