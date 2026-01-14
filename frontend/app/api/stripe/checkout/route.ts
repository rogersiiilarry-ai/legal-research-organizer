// frontend/app/api/stripe/checkout/route.ts
import { NextResponse } from "next/server";
import Stripe from "stripe";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ------------------------------- helpers ------------------------------- */

function json(status: number, payload: any) {
  return NextResponse.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "x-checkout-handler": "stripe-checkout-route-ts-2026-01-14-B",
    },
  });
}

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function safeStr(v: any) {
  return typeof v === "string" ? v.trim() : "";
}

function normalizeTier(v: any): "basic" | "pro" {
  const s = safeStr(v).toLowerCase();
  return s === "pro" ? "pro" : "basic";
}

function readBearerToken(req: Request) {
  const h = req.headers.get("authorization") || req.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || "";
}

/* ------------------------------- auth ------------------------------- */
/**
 * Prefer Bearer token (works even when cookies are missing on Vercel),
 * fall back to cookies for normal browser flows.
 */
async function requireUser(req: Request) {
  const bearer = readBearerToken(req);

  // 1) Bearer token auth
  if (bearer) {
    const supabaseJwt = createClient(
      mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
      mustEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
      { auth: { persistSession: false } }
    );

    const { data, error } = await supabaseJwt.auth.getUser(bearer);
    if (!error && data?.user) return { user: data.user, mode: "bearer" as const };
  }

  // 2) Cookie auth fallback
  const cookieStore = cookies();

  const supabase = createServerClient(
    mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
    mustEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        // cookies are not required to be mutated for getUser()
        set() {},
        remove() {},
      },
    }
  );

  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) return null;

  return { user: data.user, mode: "cookie" as const };
}

/* --------------------------------- route -------------------------------- */

export async function POST(req: Request) {
  try {
    const authed = await requireUser(req);
    if (!authed) {
      return json(401, {
        ok: false,
        error: "Unauthorized",
        hint: "Send Authorization: Bearer <supabase_access_token> or ensure Supabase auth cookies are present.",
      });
    }

    const body = await req.json().catch(() => ({}));

    const analysisId = safeStr(body?.analysis_id || body?.analysisId);
    const tier = normalizeTier(body?.tier);

    if (!analysisId) return json(400, { ok: false, error: "analysisId (or analysis_id) required" });

    const stripe = new Stripe(mustEnv("STRIPE_SECRET_KEY"));

    const priceId = tier === "pro" ? mustEnv("STRIPE_PRICE_PRO") : mustEnv("STRIPE_PRICE_BASIC");

    // Guard: this endpoint is one-time checkout only.
    const price = await stripe.prices.retrieve(priceId);
    if (price.recurring) {
      return json(500, {
        ok: false,
        error: "STRIPE_PRICE_* is recurring. This endpoint uses mode=payment and requires a one-time price.",
        debug: { priceId, recurring: price.recurring },
      });
    }

    // Admin (service role) for DB update
    const admin = createClient(
      mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
      mustEnv("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false } }
    );

    // Read existing meta
    const { data: analysis, error: readErr } = await admin
      .from("analyses")
      .select("meta")
      .eq("id", analysisId)
      .single();

    if (readErr) return json(500, { ok: false, error: readErr.message });

    const meta = (analysis?.meta || {}) as any;

    // Persist requested tier on the analysis (unpaid until webhook flips it)
    const { error: updErr } = await admin
      .from("analyses")
      .update({ meta: { ...meta, tier, paid: false } })
      .eq("id", analysisId);

    if (updErr) return json(500, { ok: false, error: updErr.message });

    const siteUrl = mustEnv("NEXT_PUBLIC_SITE_URL").replace(/\/$/, "");

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${siteUrl}/audit?analysisId=${encodeURIComponent(analysisId)}&paid=1`,
      cancel_url: `${siteUrl}/audit?analysisId=${encodeURIComponent(analysisId)}&canceled=1`,
      client_reference_id: analysisId,
      metadata: {
        analysis_id: analysisId,
        user_id: authed.user.id,
        tier,
        auth_mode: authed.mode,
      },
    });

    return json(200, { ok: true, url: session.url });
  } catch (e: any) {
    return json(500, { ok: false, error: e?.message || "Checkout error" });
  }
}
