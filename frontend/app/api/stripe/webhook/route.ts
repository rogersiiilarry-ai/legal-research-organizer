// frontend/app/api/stripe/webhook/route.ts
import { NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ------------------------------- helpers ------------------------------- */

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

async function resolveToken(admin: any, token: string) {
  const { data, error } = await admin
    .from("purchase_tokens")
    .select("*")
    .eq("token", token)
    .maybeSingle();

  if (error) return { ok: false as const, error: error.message };
  if (!data) return { ok: false as const, error: "Token not found" };

  const exp = new Date(data.expires_at).getTime();
  if (Number.isFinite(exp) && exp < Date.now()) return { ok: false as const, error: "Token expired" };
  if (data.used_at) return { ok: false as const, error: "Token already used" };

  return { ok: true as const, row: data };
}

/* --------------------------------- route -------------------------------- */

export async function POST(req: Request) {
  const stripe = new Stripe(mustEnv("STRIPE_SECRET_KEY"));

  try {
    const sig = req.headers.get("stripe-signature");
    if (!sig) return json(400, { ok: false, error: "Missing stripe-signature header" });

    // Raw body for signature verification
    const raw = await req.arrayBuffer();
    const buf = Buffer.from(raw);

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(buf, sig, mustEnv("STRIPE_WEBHOOK_SECRET"));
    } catch (err: any) {
      return json(400, { ok: false, error: `Webhook signature verification failed: ${err?.message || String(err)}` });
    }

    const supported = new Set([
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
    ]);

    if (!supported.has(event.type)) {
      return json(200, { ok: true, handled: false, type: event.type });
    }

    const session = event.data.object as Stripe.Checkout.Session;

    // For Payment Links, we pass our opaque token here:
    const token = String(session.client_reference_id || "").trim();

    if (!token) {
      // ACK to avoid retries; payment succeeded but we can't link it
      return json(200, {
        ok: true,
        handled: true,
        warning: "Missing client_reference_id (token)",
        eventId: event.id,
        type: event.type,
      });
    }

    const admin = supabaseAdmin();

    // Resolve token → analysis_id
    const resolved = await resolveToken(admin, token);
    if (!resolved.ok) {
      return json(200, {
        ok: true,
        handled: true,
        warning: resolved.error,
        token,
        eventId: event.id,
        type: event.type,
      });
    }

    const analysisId = String(resolved.row.analysis_id);

    // Determine tier (optional). If you have separate payment links, you can set product on token row.
    const tier: "basic" | "pro" =
      resolved.row.product === "audit_pro" ? "pro" : "basic";

    // Load analysis meta
    const { data: row, error: readErr } = await admin
      .from("analyses")
      .select("meta")
      .eq("id", analysisId)
      .single();

    if (readErr) {
      return json(200, { ok: true, handled: true, analysisId, warning: readErr.message, eventId: event.id });
    }

    const meta = (row?.meta || {}) as any;

    // Idempotent: if already paid, we still burn token if possible and ACK.
    const alreadyPaid = meta?.paid === true;

    // Update analysis meta to paid
    if (!alreadyPaid) {
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
        // ACK so Stripe doesn't retry forever; you can inspect logs and fix manually if needed
        return json(200, { ok: true, handled: true, analysisId, warning: updErr.message, eventId: event.id });
      }
    }

    // Burn token (atomic one-time)
    const { error: burnErr } = await admin
      .from("purchase_tokens")
      .update({
        used_at: new Date().toISOString(),
        stripe_session_id: session.id,
        stripe_payment_intent: typeof session.payment_intent === "string" ? session.payment_intent : null,
        stripe_customer: typeof session.customer === "string" ? session.customer : null,
        amount_total: session.amount_total ?? null,
        currency: session.currency ?? null,
      })
      .eq("token", token)
      .is("used_at", null);

    // If burnErr happens, we still ACK; payment is valid and analysis may already be unlocked
    return json(200, {
      ok: true,
      handled: true,
      analysisId,
      token,
      alreadyPaid,
      burned: !burnErr,
      burnWarning: burnErr?.message || null,
      eventId: event.id,
    });
  } catch (e: any) {
    // 500 so Stripe retries if something truly unexpected happened
    return json(500, { ok: false, error: e?.message || String(e) });
  }
}
