// frontend/app/api/stripe/webhook/route.ts
import { NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stripe webhooks MUST read the raw body for signature verification.
 * Do NOT call req.json() first.
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
  return createClient(mustEnv("NEXT_PUBLIC_SUPABASE_URL"), mustEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });
}

// Stripe wants the RAW payload bytes for signature verification.
// In Next Route Handlers, `await req.text()` gives the raw string body.
// (If you need bytes: Buffer.from(text, "utf8") is fine.)
export async function POST(req: Request) {
  try {
    const stripe = new Stripe(mustEnv("STRIPE_SECRET_KEY"));
    const sig = req.headers.get("stripe-signature");
    if (!sig) return json(400, { ok: false, error: "Missing stripe-signature header" });

    const rawBody = await req.text().catch(() => "");
    if (!rawBody) return json(400, { ok: false, error: "Empty body" });

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, sig, mustEnv("STRIPE_WEBHOOK_SECRET"));
    } catch (err: any) {
      return json(400, { ok: false, error: `Webhook signature verification failed: ${err?.message || err}` });
    }

    // We only need checkout completion for your flow.
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;

      // Prefer metadata analysis_id; fallback to client_reference_id
      const analysisId =
        String((session.metadata as any)?.analysis_id || "").trim() ||
        String(session.client_reference_id || "").trim();

      const tierRaw = String((session.metadata as any)?.tier || "").toLowerCase().trim();
      const tier: "basic" | "pro" = tierRaw === "pro" ? "pro" : "basic";

      if (!analysisId) {
        // Acknowledge webhook so Stripe doesn't retry forever, but report reason.
        return json(200, { ok: true, handled: true, warning: "No analysis_id on session metadata/client_reference_id" });
      }

      const admin = supabaseAdmin();

      // Idempotent-ish update:
      // - Load existing meta
      // - Set paid true + tier
      const { data: row, error: readErr } = await admin.from("analyses").select("meta").eq("id", analysisId).single();

      if (readErr) {
        // Still return 200 so Stripe doesn't retry endlessly, but include error for logs.
        return json(200, { ok: true, handled: true, analysisId, warning: readErr.message });
      }

      const meta = (row?.meta || {}) as any;

      // If already paid, do nothing.
      if (meta?.paid === true) {
        return json(200, { ok: true, handled: true, analysisId, alreadyPaid: true });
      }

      const nextMeta = {
        ...meta,
        paid: true,
        tier,
        executed_tier: meta.executed_tier || tier,
        exportAllowed: tier === "pro",
        stripe: {
          ...(meta?.stripe || {}),
          checkout_session_id: session.id,
          payment_intent: typeof session.payment_intent === "string" ? session.payment_intent : null,
          customer: typeof session.customer === "string" ? session.customer : null,
          amount_total: session.amount_total ?? null,
          currency: session.currency ?? null,
          paid_at: new Date().toISOString(),
        },
      };

      const { error: updErr } = await admin.from("analyses").update({ meta: nextMeta }).eq("id", analysisId);

      if (updErr) {
        return json(200, { ok: true, handled: true, analysisId, warning: updErr.message });
      }

      return json(200, { ok: true, handled: true, analysisId });
    }

    // Ignore other events but acknowledge.
    return json(200, { ok: true, handled: false, type: event.type });
  } catch (e: any) {
    // If we return 500, Stripe will retry. For unexpected errors, retry is often OK.
    return json(500, { ok: false, error: e?.message || String(e) });
  }
}
