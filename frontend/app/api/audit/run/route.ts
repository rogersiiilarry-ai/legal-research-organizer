// frontend/app/api/audit/run/route.ts
import { NextResponse } from "next/server";
import Stripe from "stripe";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* -------------------------------- helpers -------------------------------- */

function json(status: number, payload: any, extraHeaders?: HeadersInit) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "no-store", ...(extraHeaders || {}) },
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

async function readJson(req: Request): Promise<any> {
  const raw = await req.text().catch(() => "");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function getOrigin(req: Request) {
  const env = process.env.NEXT_PUBLIC_SITE_URL;
  if (env && env.trim()) return env.trim().replace(/\/$/, "");

  const proto = safeStr(req.headers.get("x-forwarded-proto")) || "https";
  const host = safeStr(req.headers.get("x-forwarded-host")) || safeStr(req.headers.get("host"));
  if (host) return `${proto}://${host}`;

  try {
    return new URL(req.url).origin;
  } catch {
    return "http://localhost:3000";
  }
}

function wantsHtml(req: Request) {
  const accept = req.headers.get("accept") || "";
  return accept.includes("text/html");
}

function normalizeTier(v: any): "basic" | "pro" {
  const s = safeStr(v).toLowerCase();
  return s === "pro" ? "pro" : "basic";
}

function isUuid(v: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v || "");
}

/* ------------------------------ auth (user) ------------------------------ */

async function requireUser(req: Request): Promise<{ id: string } | null> {
  // Cookie auth only (this is a user-initiated UI action)
  const cookieStore = cookies();

  const supabase = createServerClient(
    mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
    mustEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        set() {},
        remove() {},
      },
    }
  );

  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user?.id) return null;
  return { id: data.user.id };
}

/* ------------------------------ DB helpers ------------------------------ */

async function loadDocument(admin: any, token: string) {
  const t = safeStr(token);
  if (!t) return { doc: null as any, error: "document_id is required" };

  const sel = "id, owner_id, title, external_id, raw";

  // If UUID: try id
  if (isUuid(t)) {
    const r = await admin.from("documents").select(sel).eq("id", t).maybeSingle();
    if (r.error) return { doc: null as any, error: r.error.message };
    if (r.data) return { doc: r.data, error: null as any };
  }

  // Else: try external_id
  const r2 = await admin.from("documents").select(sel).eq("external_id", t).maybeSingle();
  if (r2.error) return { doc: null as any, error: r2.error.message };
  if (r2.data) return { doc: r2.data, error: null as any };

  return { doc: null as any, error: null as any };
}

/**
 * IMPORTANT:
 * This is your current placeholder entitlement check.
 * Replace later with real subscription/entitlement logic.
 */
async function isEntitled(_admin: any, _userId: string, _tier: "basic" | "pro"): Promise<boolean> {
  return false;
}

/* ------------------------------ Stripe helpers ------------------------------ */

function pickPriceId(tier: "basic" | "pro") {
  return tier === "pro" ? mustEnv("STRIPE_PRICE_PRO") : mustEnv("STRIPE_PRICE_BASIC");
}

async function createCheckoutSession(opts: {
  origin: string;
  tier: "basic" | "pro";
  userId: string;
  analysisId: string;
  documentId: string;
}) {
  const stripe = new Stripe(mustEnv("STRIPE_SECRET_KEY"));

  const priceId = pickPriceId(opts.tier);

  // mode=payment means STRIPE_PRICE_* MUST be a one-time price
  const price = await stripe.prices.retrieve(priceId);
  if (price.recurring) {
    throw new Error(
      `STRIPE_PRICE_${opts.tier.toUpperCase()} is recurring. For mode=payment you must use a one-time Price ID.`
    );
  }

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${opts.origin}/audit?analysisId=${encodeURIComponent(opts.analysisId)}&paid=1`,
    cancel_url: `${opts.origin}/audit?analysisId=${encodeURIComponent(opts.analysisId)}&canceled=1`,
    client_reference_id: opts.analysisId,
    metadata: {
      analysis_id: opts.analysisId,
      user_id: opts.userId,
      document_id: opts.documentId,
      tier: opts.tier,
      product: "materialize",
    },
  });

  return session.url || null;
}

/* ------------------------------ Materialize call ------------------------------ */

async function callMaterialize(origin: string, documentId: string, timeoutMs: number) {
  const ingest = safeStr(process.env.INGEST_SECRET);
  if (!ingest) throw new Error("Missing INGEST_SECRET");

  const u = new URL(`/api/documents/${documentId}/materialize`, origin);
  u.searchParams.set("timeoutMs", String(timeoutMs || 45000));

  const res = await fetch(u.toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ingest-secret": ingest,
    },
    body: JSON.stringify({}),
    cache: "no-store",
  });

  const j = await res.json().catch(() => ({}));
  if (!res.ok || j?.ok === false) throw new Error(j?.error || `Materialize failed (${res.status})`);
  return j;
}

/* --------------------------------- handler --------------------------------- */

async function handle(req: Request) {
  const user = await requireUser(req);
  if (!user) return json(401, { ok: false, phase: "auth", error: "Unauthorized" });

  const body = await readJson(req);
  const u = new URL(req.url);

  // Allow tier selection from UI at materialize time
  const tier = normalizeTier(body?.tier ?? u.searchParams.get("tier") ?? "basic");

  const documentToken = safeStr(body?.document_id ?? body?.documentId ?? u.searchParams.get("document_id") ?? u.searchParams.get("documentId"));
  if (!documentToken) return json(400, { ok: false, phase: "input", error: "document_id is required" });

  const timeoutMs = Number(body?.timeoutMs ?? body?.materialize?.timeoutMs ?? 45000) || 45000;

  const admin = createClient(
    mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
    mustEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } }
  );

  const { doc, error: loadErr } = await loadDocument(admin, documentToken);
  if (loadErr) return json(500, { ok: false, phase: "load_document", error: loadErr });
  if (!doc) return json(404, { ok: false, phase: "load_document", error: "Document not found", identifier: documentToken });

  const documentId = String(doc.id);

  // Ownership enforcement
  if (doc.owner_id && String(doc.owner_id) !== user.id) {
    return json(403, { ok: false, phase: "authz", error: "Forbidden" });
  }

  // Create an analysis row immediately (represents the attempted materialize purchase/execution)
  const origin = getOrigin(req);

  const { data: created, error: createErr } = await admin
    .from("analyses")
    .insert({
      scope: "document",
      status: "pending_payment",
      owner_id: user.id,
      target_document_id: documentId,
      title: `materialize (${new Date().toISOString()})`,
      meta: {
        kind: "materialize",
        tier,
        paid: false,
        source: "audit/run",
        document_identifier: documentToken,
      },
    })
    .select("id")
    .single();

  if (createErr) return json(500, { ok: false, phase: "create_analysis", error: createErr.message });

  const analysisId = String(created.id);

  // Entitlement check
  const entitled = await isEntitled(admin, user.id, tier);

  // If not entitled → send to checkout NOW
  if (!entitled) {
    const checkoutUrl = await createCheckoutSession({
      origin,
      tier,
      userId: user.id,
      analysisId,
      documentId,
    });

    if (!checkoutUrl) return json(500, { ok: false, phase: "stripe", error: "Failed to create checkout session" });

    // Persist checkout URL for debugging / reconciliation
    await admin.from("analyses").update({
      meta: {
        kind: "materialize",
        tier,
        paid: false,
        source: "audit/run",
        document_identifier: documentToken,
        checkout_url: checkoutUrl,
      },
    }).eq("id", analysisId);

    if (wantsHtml(req)) return NextResponse.redirect(checkoutUrl, 303);

    return json(402, {
      ok: false,
      phase: "stripe",
      error: "Payment required",
      analysisId,
      checkout_url: checkoutUrl,
    });
  }

  // Entitled → materialize now
  try {
    await admin.from("analyses").update({ status: "running" }).eq("id", analysisId);

    await callMaterialize(origin, documentId, timeoutMs);

    await admin.from("analyses").update({
      status: "completed",
      summary: "Materialize completed.",
      meta: {
        kind: "materialize",
        tier,
        paid: true,
        source: "audit/run",
        document_identifier: documentToken,
        completed_at: new Date().toISOString(),
      },
    }).eq("id", analysisId);

    return json(200, { ok: true, phase: "completed", analysisId, document_id: documentId });
  } catch (e: any) {
    await admin.from("analyses").update({
      status: "error",
      error: e?.message || "Materialize failed",
    }).eq("id", analysisId);

    return json(500, { ok: false, phase: "materialize", error: e?.message || "Materialize failed", analysisId });
  }
}

export async function POST(req: Request) {
  return handle(req);
}

export async function GET(req: Request) {
  // For browser navigation compatibility (optional)
  return handle(req);
}
