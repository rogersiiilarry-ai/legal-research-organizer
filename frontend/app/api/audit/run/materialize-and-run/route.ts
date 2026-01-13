// app/api/audit/run/materialize-and-run/route.ts
import Stripe from "stripe";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* -------------------------------- helpers -------------------------------- */

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

async function readJson(req: Request): Promise<any> {
  const raw = await req.text().catch(() => "");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function safeStr(v: any, max = 2000) {
  if (typeof v !== "string") return "";
  const s = v.trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max) : s;
}

function toBool(v: any) {
  return v === true || v === "true" || v === 1 || v === "1";
}

function isUuid(v: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v || "");
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function asInt(v: any, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function normalizeExternalId(token: string) {
  const s = String(token || "").trim();
  if (!s) return "";
  if (s.startsWith("uri:")) return "url:" + s.slice(4);
  if (s.startsWith("url:")) return s;
  if (/^[0-9a-f]{40}$/i.test(s)) return `url:${s}`;
  return s;
}

/* ---------------------------------- auth ---------------------------------- */

type AuthResult =
  | { ok: true; mode: "system"; userId: null }
  | { ok: true; mode: "user"; userId: string }
  | { ok: false; status: number; error: string };

async function requireSystemOrUser(req: Request): Promise<AuthResult> {
  const provided = req.headers.get("x-ingest-secret") || "";
  const expected = process.env.INGEST_SECRET || "";

  // system bypass
  if (expected && provided && provided === expected) {
    return { ok: true, mode: "system", userId: null };
  }

  // user cookie auth (browser)
  const cookieStore = cookies();

  // IMPORTANT: implement set/remove so cookies refresh works
  const supabaseAuth = createServerClient(
    mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
    mustEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        set(name: string, value: string, options: any) {
          cookieStore.set({ name, value, ...options });
        },
        remove(name: string, options: any) {
          cookieStore.set({ name, value: "", ...options, maxAge: 0 });
        },
      },
    }
  );

  const { data, error } = await supabaseAuth.auth.getUser();
  if (error || !data?.user?.id) return { ok: false, status: 401, error: "Unauthorized" };

  return { ok: true, mode: "user", userId: data.user.id };
}

/* --------------------------- entitlement helpers --------------------------- */

type DbEntitlement = { isAdmin: boolean; freeAccess: boolean; freeTier: "basic" | "pro" | null };

function normalizeTier(v: any): "basic" | "pro" {
  const t = safeStr(v, 20).toLowerCase();
  return t === "pro" ? "pro" : "basic";
}

function isAdminAllowlist(userId: string | null) {
  if (!userId) return false;
  const raw = process.env.ADMIN_USER_IDS || "";
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.includes(userId);
}

async function tryGetDbEntitlement(supabase: any, userId: string): Promise<DbEntitlement> {
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("is_admin, free_access, free_tier")
      .eq("id", userId)
      .maybeSingle();

    if (error || !data) return { isAdmin: false, freeAccess: false, freeTier: null };

    const isAdmin = toBool((data as any).is_admin);
    const freeAccess = toBool((data as any).free_access);
    const ft = safeStr((data as any).free_tier, 20).toLowerCase();
    const freeTier = ft === "pro" ? "pro" : ft === "basic" ? "basic" : null;

    return { isAdmin, freeAccess, freeTier };
  } catch {
    return { isAdmin: false, freeAccess: false, freeTier: null };
  }
}

function siteOrigin(req: Request) {
  const env = process.env.NEXT_PUBLIC_SITE_URL;
  if (env && env.trim()) return env.trim();

  const host = process.env.VERCEL_URL;
  if (host && host.trim()) return `https://${host.trim()}`;

  return new URL(req.url).origin;
}

function pickPrice(tier: "basic" | "pro") {
  return tier === "pro" ? mustEnv("STRIPE_PRICE_PRO") : mustEnv("STRIPE_PRICE_BASIC");
}

async function createCheckout(origin: string, tier: "basic" | "pro", userId: string, analysisId: string) {
  const stripe = new Stripe(mustEnv("STRIPE_SECRET_KEY"));
  const price = pickPrice(tier);

  // keep stable
  const success_url = `${origin}/app/audit?analysis=${encodeURIComponent(analysisId)}&checkout=success`;
  const cancel_url = `${origin}/app/audit?analysis=${encodeURIComponent(analysisId)}&checkout=cancel`;

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price, quantity: 1 }],
    success_url,
    cancel_url,
    client_reference_id: analysisId,
    metadata: {
      analysis_id: analysisId,
      user_id: userId,
      tier,
      product: "audit-execute",
    },
  });

  return session.url || null;
}

/* ------------------------ doc lookup + pdf resolve ------------------------ */

async function loadDocumentByIdOrExternalId(supabase: any, token: string) {
  const id = String(token || "").trim();
  if (!id) return { doc: null as any, error: "document_id is required" };

  const sel = "id, owner_id, raw, title, external_id";

  if (isUuid(id)) {
    const r = await supabase.from("documents").select(sel).eq("id", id).maybeSingle();
    if (r.error) return { doc: null as any, error: r.error.message };
    if (r.data) return { doc: r.data, error: null as any };
  }

  const ext = normalizeExternalId(id);
  const r2 = await supabase.from("documents").select(sel).eq("external_id", ext).maybeSingle();
  if (r2.error) return { doc: null as any, error: r2.error.message };
  if (r2.data) return { doc: r2.data, error: null as any };

  return { doc: null as any, error: null as any };
}

function pickPdfCandidate(raw: any): string | null {
  if (!raw || typeof raw !== "object") return null;
  const direct =
    (typeof raw.pdf_url === "string" && raw.pdf_url) ||
    (typeof raw.pdfUrl === "string" && raw.pdfUrl) ||
    (typeof raw.pdf === "string" && raw.pdf) ||
    (typeof raw.url === "string" && raw.url) ||
    null;
  return direct ? String(direct).trim() : null;
}

async function resolvePdfUrl(_supabase: any, doc: any): Promise<{ pdfUrl: string | null; source: string }> {
  const direct =
    (typeof doc?.pdf_url === "string" && doc.pdf_url) ||
    (typeof doc?.pdfUrl === "string" && doc.pdfUrl) ||
    (typeof doc?.pdf === "string" && doc.pdf) ||
    (typeof doc?.url === "string" && doc.url) ||
    null;

  if (direct && String(direct).trim()) return { pdfUrl: String(direct).trim(), source: "documents.*" };

  const rawCandidate = pickPdfCandidate(doc?.raw);
  if (rawCandidate) return { pdfUrl: rawCandidate, source: "documents.raw" };

  return { pdfUrl: null, source: "none" };
}

async function ensureMaterialized(baseUrl: string, documentId: string, ingestSecret: string, timeoutMs: number) {
  const u = new URL(`/api/documents/${documentId}/materialize`, baseUrl);
  u.searchParams.set("timeoutMs", String(timeoutMs || 45000));

  const res = await fetch(u.toString(), {
    method: "POST",
    headers: {
      "x-ingest-secret": ingestSecret,
      "content-type": "application/json",
    },
  });

  const payload = await res.json().catch(() => ({} as any));
  if (!res.ok || payload?.ok === false) {
    throw new Error(payload?.error || `Materialize failed: ${res.status} ${res.statusText}`);
  }

  return payload;
}

/* ---------------------------------- route ---------------------------------- */

export async function POST(req: Request) {
  const startedAt = Date.now();

  try {
    const auth = await requireSystemOrUser(req);
    if (auth.ok === false) return json(auth.status, { ok: false, phase: "auth", error: auth.error });

    const body = await readJson(req);
    const u = new URL(req.url);

    const documentToken = safeStr(
      body?.document_id ??
        body?.documentId ??
        u.searchParams.get("document_id") ??
        u.searchParams.get("documentId") ??
        "",
      400
    );

    if (!documentToken) return json(400, { ok: false, phase: "input", error: "document_id is required" });

    const tier = normalizeTier(body?.tier ?? body?.withPdf ? "pro" : "basic");
    const kind = safeStr(body?.kind ?? u.searchParams.get("kind") ?? "case_fact_audit", 80) || "case_fact_audit";
    const timeoutMs = clamp(asInt(body?.timeoutMs ?? body?.materialize?.timeoutMs, 45000), 5000, 120000);

    const supabase = createClient(mustEnv("NEXT_PUBLIC_SUPABASE_URL"), mustEnv("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false },
    });

    const { doc, error: loadErr } = await loadDocumentByIdOrExternalId(supabase, documentToken);
    if (loadErr) return json(500, { ok: false, phase: "load_document", error: loadErr });
    if (!doc) {
      return json(404, {
        ok: false,
        phase: "load_document",
        error: "Document not found for given identifier (id or external_id)",
        identifier: documentToken,
      });
    }

    // authz
    if (auth.mode === "user" && doc.owner_id && doc.owner_id !== auth.userId) {
      return json(403, { ok: false, phase: "authz", error: "Forbidden" });
    }

    const resolved = await resolvePdfUrl(supabase, doc);
    if (!resolved.pdfUrl) return json(400, { ok: false, phase: "resolve_pdf_url", error: "No PDF URL resolved" });

    const owner_id = auth.mode === "user" ? auth.userId : mustEnv("SYSTEM_OWNER_ID").trim();

    // ALWAYS create analysis first (fixes your UI)
    const { data: created, error: createErr } = await supabase
      .from("analyses")
      .insert({
        scope: "document",
        status: "pending",
        target_document_id: doc.id,
        owner_id,
        title: `${kind} (${new Date().toISOString()})`,
        meta: {
          kind,
          source: "materialize-and-run",
          tier,
          paid: false,
          pdf_url: resolved.pdfUrl,
          pdf_resolved_from: resolved.source,
          document_identifier: documentToken,
        },
      })
      .select("id")
      .single();

    if (createErr) return json(500, { ok: false, phase: "create_analysis", error: createErr.message });

    const analysisId = String(created.id);

    // entitlement check for user mode (system bypass)
    if (auth.mode === "user") {
      const dbEntitlement = await tryGetDbEntitlement(supabase, auth.userId);
      const isAdmin = isAdminAllowlist(auth.userId) || dbEntitlement.isAdmin;

      const freeOk =
        dbEntitlement.freeAccess &&
        (dbEntitlement.freeTier === "pro" ? true : tier === "basic");

      // if not admin and not free => require payment
      if (!isAdmin && !freeOk) {
        const origin = siteOrigin(req);
        const checkoutUrl = await createCheckout(origin, tier, auth.userId, analysisId);
        if (!checkoutUrl) return json(500, { ok: false, phase: "stripe", error: "Failed to create checkout session" });

        // IMPORTANT: return 200 so UI can store analysisId and show checkout button
        return json(200, {
          ok: true,
          phase: "payment_required",
          requires_payment: true,
          analysisId,
          tier,
          checkout_url: checkoutUrl,
        });
      }
    }

    // entitled/system: materialize now
    const origin = siteOrigin(req);
    const ingestSecret = process.env.INGEST_SECRET || "";
    if (!ingestSecret) throw new Error("Missing INGEST_SECRET for internal materialize call");

    await supabase.from("analyses").update({ status: "running", error: null }).eq("id", analysisId);

    await ensureMaterialized(origin, String(doc.id), ingestSecret, timeoutMs);

    const elapsedMs = Date.now() - startedAt;

    await supabase
      .from("analyses")
      .update({
        status: "materialized",
        summary: "Document materialized into searchable chunks.",
        meta: {
          ...(doc?.meta || {}),
          kind,
          source: "materialize-and-run",
          tier,
          paid: true, // if we got here in user mode, it was free/admin; system mode always allowed
          pdf_url: resolved.pdfUrl,
          pdf_resolved_from: resolved.source,
          elapsed_ms: elapsedMs,
        },
      })
      .eq("id", analysisId);

    return json(200, {
      ok: true,
      phase: "materialized",
      analysisId,
      document_id: String(doc.id),
      pdf_url: resolved.pdfUrl,
      tier,
      requires_payment: false,
    });
  } catch (e: any) {
    return json(500, { ok: false, phase: "exception", error: e?.message || String(e) });
  }
}