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

function asInt(v: any, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function normalizeText(input: string) {
  return (input || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function chunkText(text: string, maxChars: number) {
  const out: string[] = [];
  if (!text) return out;

  const paras = text
    .split(/\n\s*\n/g)
    .map((p) => p.trim())
    .filter(Boolean);

  let buf = "";
  for (const p of paras) {
    if (!buf) {
      buf = p;
      continue;
    }
    if (buf.length + 2 + p.length <= maxChars) {
      buf += "\n\n" + p;
      continue;
    }
    out.push(buf);
    buf = p;

    while (buf.length > maxChars) {
      out.push(buf.slice(0, maxChars));
      buf = buf.slice(maxChars);
    }
  }

  if (buf.trim()) out.push(buf.trim());
  return out;
}

function isUuid(v: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v || "");
}

/* ---------------------------------- auth ---------------------------------- */

type AuthResult =
  | { ok: true; mode: "system"; userId: null }
  | { ok: true; mode: "user"; userId: string }
  | { ok: false; status: number; error: string };

function readBearerToken(req: Request) {
  const h = req.headers.get("authorization") || req.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || "";
}

async function requireSystemOrUser(req: Request): Promise<AuthResult> {
  // 1) System secret bypass (internal automation only)
  const provided = req.headers.get("x-ingest-secret") || "";
  const expected = process.env.INGEST_SECRET || "";
  if (expected && provided && provided === expected) {
    return { ok: true, mode: "system", userId: null };
  }

  // 2) Bearer token auth (reliable even when SSR cookies are missing)
  const bearer = readBearerToken(req);
  if (bearer) {
    const supabaseJwt = createClient(
      mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
      mustEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
      { auth: { persistSession: false } }
    );

    const { data, error } = await supabaseJwt.auth.getUser(bearer);
    if (!error && data?.user?.id) {
      return { ok: true, mode: "user", userId: data.user.id };
    }
  }

  // 3) Cookie auth fallback (best-effort)
  const cookieStore = cookies();
  const supabaseAuth = createServerClient(
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

  const { data, error } = await supabaseAuth.auth.getUser();
  if (error || !data?.user?.id) return { ok: false, status: 401, error: "Unauthorized" };

  return { ok: true, mode: "user", userId: data.user.id };
}

/* --------------------------- stripe + entitlement --------------------------- */
/**
 * TODO: Wire this to real entitlements:
 * - profiles.plan in ('basic','pro')
 * - or subscriptions table with status='active'
 * For now: always false => always paywalled for user mode.
 */
async function isEntitled(_supabase: any, _userId: string, _withPdf: boolean): Promise<boolean> {
  return false;
}

function siteOrigin(req: Request) {
  const env = process.env.NEXT_PUBLIC_SITE_URL;
  if (env && env.trim()) return env.trim();

  const host = process.env.VERCEL_URL;
  if (host && host.trim()) return `https://${host.trim()}`;

  return new URL(req.url).origin;
}

function pickPrice(withPdf: boolean) {
  return withPdf ? mustEnv("STRIPE_PRICE_PRO") : mustEnv("STRIPE_PRICE_BASIC");
}

async function createCheckout(origin: string, withPdf: boolean, userId: string, documentId: string) {
  const stripe = new Stripe(mustEnv("STRIPE_SECRET_KEY"));
  const price = pickPrice(withPdf);

  const success_url = `${origin}/audit?checkout=success&doc=${encodeURIComponent(documentId)}`;
  const cancel_url = `${origin}/audit?checkout=cancel&doc=${encodeURIComponent(documentId)}`;

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price, quantity: 1 }],
    success_url,
    cancel_url,
    client_reference_id: userId,
    metadata: {
      user_id: userId,
      document_id: documentId,
      tier: withPdf ? "pro" : "basic",
      product: "materialize-and-run",
    },
  });

  return session.url || null;
}

function wantsHtmlRedirect(req: Request) {
  const accept = req.headers.get("accept") || "";
  return accept.includes("text/html");
}

/* ------------------------ document lookup + pdf resolve ------------------------ */

function normalizeExternalId(token: string) {
  const s = String(token || "").trim();
  if (!s) return "";
  if (s.startsWith("uri:")) return "url:" + s.slice(4);
  if (s.startsWith("url:")) return s;
  if (/^[0-9a-f]{40}$/i.test(s)) return `url:${s}`;
  return s;
}

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

function runDeterministicAudit(text: string, maxFindings: number) {
  const findings: any[] = [];
  const limit = Math.max(1, Math.min(50, Number(maxFindings) || 12));

  const t = String(text || "");
  const len = t.length;

  findings.push({
    title: "Record text extracted",
    severity: "info",
    claim: `Text was extracted and is suitable for downstream analysis. Length: ${len.toLocaleString()} chars.`,
    evidence: [{ bullets: [`Extracted character length: ${len.toLocaleString()}`] }],
  });

  const flags: string[] = [];
  if (/\bmiranda\b/i.test(t)) flags.push("Miranda term detected");
  if (/\bwarrant\b/i.test(t)) flags.push("Warrant term detected");
  if (/\barraign/i.test(t)) flags.push("Arraignment term detected");
  if (/\bplea\b/i.test(t)) flags.push("Plea term detected");
  if (/\bbond\b/i.test(t)) flags.push("Bond term detected");

  if (flags.length) {
    findings.push({
      title: "Key terms detected",
      severity: "info",
      claim:
        "The record contains one or more high-signal legal procedure terms. This is a keyword-level observation for research.",
      evidence: [{ bullets: flags.map((s) => `• ${s}`) }],
    });
  }

  return findings.slice(0, limit);
}

/* ---------------------------------- route ---------------------------------- */

export async function POST(req: Request) {
  const startedAt = Date.now();

  try {
    const auth = await requireSystemOrUser(req);
    if (auth.ok === false) return json(auth.status, { ok: false, phase: "auth", error: auth.error });

    const body = await readJson(req);
    const u = new URL(req.url);

    const documentToken = String(
      body?.document_id ??
        body?.documentId ??
        u.searchParams.get("document_id") ??
        u.searchParams.get("documentId") ??
        ""
    ).trim();

    if (!documentToken) return json(400, { ok: false, phase: "input", error: "document_id is required" });

    const withPdf = Boolean(body?.withPdf ?? body?.with_pdf ?? u.searchParams.get("withPdf") === "1");
    const kind = String(body?.kind ?? u.searchParams.get("kind") ?? "case_fact_audit").trim() || "case_fact_audit";
    const maxFindings = clamp(asInt(body?.maxFindings, 25), 1, 100);

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

    const documentId = String(doc.id);

    // User authz (system bypasses)
    if (auth.mode === "user" && doc.owner_id && doc.owner_id !== auth.userId) {
      return json(403, { ok: false, phase: "authz", error: "Forbidden" });
    }

    // PAYWALL
    if (auth.mode === "user") {
      const entitled = await isEntitled(supabase, auth.userId, withPdf);

      if (!entitled) {
        const origin = siteOrigin(req);
        const checkoutUrl = await createCheckout(origin, withPdf, auth.userId, documentId);

        if (!checkoutUrl) return json(500, { ok: false, phase: "stripe", error: "Failed to create checkout session" });

        if (wantsHtmlRedirect(req)) return NextResponse.redirect(checkoutUrl, 303);

        return json(402, { ok: false, phase: "stripe", error: "Payment required", checkout_url: checkoutUrl });
      }
    }

    // Materialize + run (system or entitled user)
    const materializeCfg = body?.materialize || {};
    const chunkMaxChars = clamp(asInt(materializeCfg?.maxChars, 4000), 800, 12000);
    const maxChunks = clamp(asInt(materializeCfg?.maxChunks, 250), 1, 2000);
    const timeoutMs = clamp(asInt(materializeCfg?.timeoutMs, 45000), 5000, 120000);

    const resolved = await resolvePdfUrl(supabase, doc);
    const pdfUrl = resolved.pdfUrl;
    if (!pdfUrl) return json(400, { ok: false, phase: "resolve_pdf_url", error: "No PDF URL resolved for document" });

    const owner_id = auth.mode === "user" ? auth.userId : mustEnv("SYSTEM_OWNER_ID").trim();

    const { data: created, error: createErr } = await supabase
      .from("analyses")
      .insert({
        scope: "document",
        status: "running",
        target_document_id: documentId,
        owner_id,
        title: `${kind} (${new Date().toISOString()})`,
        meta: {
          kind,
          source: "materialize-and-run",
          pdf_url: pdfUrl,
          pdf_resolved_from: resolved.source,
          document_identifier: documentToken,
          with_pdf: withPdf,
        },
      })
      .select("id")
      .single();

    if (createErr) return json(500, { ok: false, phase: "create_analysis", error: createErr.message });

    const analysisId = String(created.id);

    const origin = siteOrigin(req);
    const ingestSecret = process.env.INGEST_SECRET || "";
    if (!ingestSecret) throw new Error("Missing INGEST_SECRET for internal materialize call");

    await ensureMaterialized(origin, documentId, ingestSecret, timeoutMs);

    const chunksRes = await supabase
      .from("chunks")
      .select("chunk_index, content")
      .eq("document_id", documentId)
      .order("chunk_index", { ascending: true });

    if (chunksRes.error) throw new Error(`Failed to load chunks: ${chunksRes.error.message}`);

    const text = normalizeText((chunksRes.data || []).map((r: any) => String(r.content || "")).join("\n\n"));
    if (!text) {
      await supabase.from("analyses").update({ status: "error", error: "Materialized but no text extracted" }).eq("id", analysisId);
      return json(422, { ok: false, phase: "materialize", error: "Materialized but no text extracted", analysisId });
    }

    const chunksText = chunkText(text, chunkMaxChars).slice(0, maxChunks);

    await supabase.from("chunks").delete().eq("document_id", documentId);
    const rows = chunksText.map((content, i) => ({ document_id: documentId, chunk_index: i, content }));

    for (let i = 0; i < rows.length; i += 200) {
      const { error: insErr } = await supabase.from("chunks").insert(rows.slice(i, i + 200));
      if (insErr) throw new Error(insErr.message);
    }

    const findings = runDeterministicAudit(text, maxFindings);
    const elapsedMs = Date.now() - startedAt;

    await supabase
      .from("analyses")
      .update({
        status: "completed",
        error: null,
        summary: `Extracted ${rows.length} chunks and generated ${findings.length} findings.`,
        meta: {
          kind,
          source: "materialize-and-run",
          pdf_url: pdfUrl,
          pdf_resolved_from: resolved.source,
          elapsed_ms: elapsedMs,
          chunk_count: rows.length,
          with_pdf: withPdf,
          findings,
        },
      })
      .eq("id", analysisId);

    return json(200, {
      ok: true,
      phase: "completed",
      analysisId,
      document_id: documentId,
      document_identifier: documentToken,
      pdf_url: pdfUrl,
      pdf_resolved_from: resolved.source,
      chunk_count: rows.length,
      findingsCount: findings.length,
      withPdf,
    });
  } catch (e: any) {
    return json(500, { ok: false, phase: "exception", error: e?.message || String(e) });
  }
}
