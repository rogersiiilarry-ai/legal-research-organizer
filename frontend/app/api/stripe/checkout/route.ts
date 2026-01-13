// frontend/app/api/stripe/checkout/route.ts
import { NextResponse } from "next/server";
import Stripe from "stripe";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(status: number, payload: any) {
  return NextResponse.json(payload, { status });
}

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

async function requireUser() {
  const cookieStore = cookies();
  const supabase = createServerClient(
    mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
    mustEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        get(name) {
          return cookieStore.get(name)?.value;
        },
        set() {},
        remove() {},
      },
    }
  );

  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) return null;
  return data.user;
}

export async function POST(req: Request) {
  try {
    const user = await requireUser();
    if (!user) return json(401, { ok: false, error: "Unauthorized" });

    const body = await req.json().catch(() => ({}));
    const analysisId = String(body?.analysis_id || "");
    const tier = String(body?.tier || "basic").toLowerCase();

    if (!analysisId) return json(400, { ok: false, error: "analysis_id required" });

    const priceId =
      tier === "pro"
        ? mustEnv("STRIPE_PRICE_PRO")
        : mustEnv("STRIPE_PRICE_BASIC");

    const stripe = new Stripe(mustEnv("STRIPE_SECRET_KEY"), {
      apiVersion: "2024-06-20",
    });

    const admin = createClient(
      mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
      mustEnv("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false } }
    );

    // Persist requested tier (unpaid)
    const { data: analysis } = await admin
      .from("analyses")
      .select("meta")
      .eq("id", analysisId)
      .single();

    const meta = (analysis?.meta || {}) as any;

    await admin
      .from("analyses")
      .update({ meta: { ...meta, tier, paid: false } })
      .eq("id", analysisId);

    const siteUrl = mustEnv("NEXT_PUBLIC_SITE_URL").replace(/\/$/, "");

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${siteUrl}/app/audit?analysis_id=${analysisId}&paid=1`,
      cancel_url: `${siteUrl}/app/audit?analysis_id=${analysisId}&canceled=1`,
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