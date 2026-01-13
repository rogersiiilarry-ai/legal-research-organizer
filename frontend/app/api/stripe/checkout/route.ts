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
    headers: { "Cache-Control": "no-store" },
  });
}

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function normalizeTier(v: any): "basic" | "pro" {
  const s = String(v || "").toLowerCase().trim();
  return s === "pro" ? "pro" : "basic";
}

async function requireUser() {
  const cookieStore = cookies();

  const supabase = createServerClient(
    mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
    mustEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        // NOTE: In Route Handlers, cookie refresh isn't always reliable.
        // We rely on existing session cookies.
        set() {},
        remove() {},
      },
    }
  );

  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) return null;
  return data.user;
}

/* --------------------------------- route -------------------------------- */

export async function POST(req: Request) {
  try {
    const user = await requireUser();
    if (!user) return json(401, { ok: false, error: "Unauthorized" });

    const body = await req.json().catch(() => ({}));
    const analysisId = String(body?.analysis_id || body?.analysisId || "").trim();
    const tier = normalizeTier(body?.tier);

    if (!analysisId) return json(400, { ok: false, error: "analysis_id required" });

    const priceId = tier === "pro" ? mustEnv("STRIPE_PRICE_PRO") : mustEnv("STRIPE_PRICE_BASIC");

    // IMPORTANT: do NOT pin apiVersion here; your installed Stripe typings
    // require a specific literal value and will break builds if mismatched.
    const stripe = new Stripe(mustEnv("STRIPE_SECRET_KEY"));

    const admin = createClient(
      mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
      mustEnv("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false } }
    );

    // Persist requested tier (unpaid) on the analysis
    const { data: analysis, error: readErr } = await admin
      .from("analyses")
      .select("meta")
      .eq("id", analysisId)
      .single();

    if (readErr) return json(500, { ok: false, error: readErr.message });

    const meta = (analysis?.meta || {}) as any;

    const { error: updErr } = await admin
      .from("analyses")
      .update({ meta: { ...meta, tier, paid: false } })
      .eq("id", analysisId);

    if (updErr) return json(500, { ok: false, error: updErr.message });

    const siteUrl = mustEnv("NEXT_PUBLIC_SITE_URL").replace(/\/$/, "");

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${siteUrl}/app/audit?analysis_id=${encodeURIComponent(analysisId)}&paid=1`,
      cancel_url: `${siteUrl}/app/audit?analysis_id=${encodeURIComponent(analysisId)}&canceled=1`,
      client_reference_id: analysisId,
      metadata: {
        analysis_id: analysisId,
        user_id: user.id,
        tier,
      },
    });

    return json(200, { ok: true, url: session.url });
  } catch (e: any) {
    return json(500, { ok: false, error: e?.message || "Checkout error" });
  }
}
