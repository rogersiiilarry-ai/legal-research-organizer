// frontend/app/api/audit/run/materialize-and-run/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { createRequire } from "module";

export const runtime = "nodejs";

/* -------------------------------- helpers -------------------------------- */

function json(status: number, payload: any) {
  return NextResponse.json(payload, { status });
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
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v || ""
  );
}

function isHttpUrl(v: string) {
  return /^https?:\/\//i.test(v || "");
}

/* ---------------------------------- auth ---------------------------------- */

type AuthResult =
  | { ok: true; mode: "system"; userId: null }
  | { ok: true; mode: "user"; userId: string }
  | { ok: false; status: number; error: string };

async function requireSystemOrUser(req: Request): Promise<AuthResult> {
  const provided = req.headers.get("x-ingest-secret") || "";
  const expected = process.env.INGEST_SECRET || "";

  if (expected && provided && provided === expected) {
    return { ok: true, mode: "system", userId: null };
  }

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

/* ------------------------ document lookup (FIX) ------------------------ */
/**
 * Accept:
 *  - documents.id UUID
 *  - documents.external_id values:
 *      "url:....", "uri:....", or raw 40-hex => normalize => "url:<hex>"
 */
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

  // 1) Try UUID => documents.id
  if (isUuid(id)) {
    const r = await supabase.from("documents").select(sel).eq("id", id).maybeSingle();
    if (r.error) return { doc: null as any, error: r.error.message };
    if (r.data) return { doc: r.data, error: null as any };
  }

  // 2) Try normalized external_id
  const ext = normalizeExternalId(id);
  const r2 = await supabase.from("documents").select(sel).eq("external_id", ext).maybeSingle();
  if (r2.error) return { doc: null as any, error: r2.error.message };
  if (r2.data) return { doc: r2.data, error: null as any };

  return { doc: null as any, error: null as any };
}

/* --------------------------- pdf fetch + parse -------------------------- */
/**
 * IMPORTANT:
 * - Do NOT reject by content-type, because many gov sites return HTML interstitials to bots.
 * - Only trust the first 5 bytes (%PDF-) as the definitive PDF check.
 */
// NOTE: pdf text materialization is handled by /api/documents/[id]/materialize (pdfjs-dist).
// Any prior pdf-parse helper was removed to keep the deployment dependency-free.

/* --------------------------- pdf url resolution helper --------------------------- */

function pickPdfCandidate(raw: any): string | null {
  if (!raw || typeof raw !== "object") return null;

  // common shapes we've seen in your pipeline
  const direct =
    (typeof raw.pdf_url === "string" && raw.pdf_url) ||
    (typeof raw.pdfUrl === "string" && raw.pdfUrl) ||
    (typeof raw.pdf === "string" && raw.pdf) ||
    (typeof raw.url === "string" && raw.url) ||
    null;

  return direct ? String(direct).trim() : null;
}


async function resolvePdfUrl(
  supabase: any,
  doc: any
): Promise<{ pdfUrl: string | null; source: string }> {
  // 1) direct doc fields
  const direct =
    (typeof doc?.pdf_url === "string" && doc.pdf_url) ||
    (typeof doc?.pdfUrl === "string" && doc.pdfUrl) ||
    (typeof doc?.pdf === "string" && doc.pdf) ||
    (typeof doc?.url === "string" && doc.url) ||
    null;

  if (direct && String(direct).trim()) return { pdfUrl: String(direct).trim(), source: "documents.*" };

  // 2) raw object
  const rawCandidate = pickPdfCandidate(doc?.raw);
  if (rawCandidate) {
    // If it's a UUID pointer, dereference to another documents row
    if (isUuid(rawCandidate)) {
      const r = await supabase.from("documents").select("id, pdf, raw, url").eq("id", rawCandidate).maybeSingle();
      if (r?.error) throw new Error(`PDF pointer lookup failed: ${r.error.message}`);
      if (!r?.data) throw new Error(`PDF pointer document not found: ${rawCandidate}`);

      const inner =
        (typeof (r.data as any)?.pdf === "string" && (r.data as any).pdf) ||
        pickPdfCandidate((r.data as any)?.raw) ||
        (typeof (r.data as any)?.url === "string" && (r.data as any).url) ||
        null;

      return { pdfUrl: inner ? String(inner).trim() : null, source: "documents(raw->pointer)" };
    }

    return { pdfUrl: rawCandidate, source: "documents.raw" };
  }

  return { pdfUrl: null, source: "none" };
}

/* --------------------------- pdf binary fetch helper --------------------------- */
async function fetchBinaryPdf(url: string, timeoutMs: number): Promise<Uint8Array> {
  const ctrl = new AbortController();
  const ms = Math.max(1000, Math.min(120000, Number(timeoutMs) || 45000));
  const t = setTimeout(() => ctrl.abort(), ms);

  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" as any });
    if (!res.ok) throw new Error(`Failed to fetch PDF: ${res.status} ${res.statusText}`);

    const ab = await res.arrayBuffer();
    const bytes = new Uint8Array(ab);

    // Hard check: PDF magic header
    if (bytes.length >= 5) {
      const sig = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4]);
      if (sig !== "%PDF-") {
        throw new Error("Fetched content is not a PDF (%PDF- header missing)");
      }
    }

    return bytes;
  } finally {
    clearTimeout(t);
  }
}
/* ------------------------ pdf materialize via internal route ------------------------ */
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

  return payload; // { ok, chunk_count, ... }
}
/* ------------------------ deterministic (no-LLM) audit findings ------------------------ */
/**
 * Produce a small set of deterministic, research-only findings from extracted text.
 * This is intentionally conservative: it does NOT provide legal advice.
 */
function runDeterministicAudit(text: string, maxFindings: number) {
  const findings: any[] = [];
  const limit = Math.max(1, Math.min(50, Number(maxFindings) || 12));

  const t = String(text || "");
  const len = t.length;

  // Basic extraction health
  findings.push({
    title: "Record text extracted",
    severity: "info",
    claim: `Text was extracted and is suitable for downstream analysis. Length: ${len.toLocaleString()} chars.`,
    evidence: [{ bullets: [`Extracted character length: ${len.toLocaleString()}`] }],
  });

  // Simple red-flag checks (deterministic)
  const hasMiranda = /\bmiranda\b/i.test(t);
  const hasWarrant = /\bwarrant\b/i.test(t);
  const hasArraign = /\barraign/i.test(t);
  const hasPlea = /\bplea\b/i.test(t);
  const hasBond = /\bbond\b/i.test(t);

  const flags: string[] = [];
  if (hasMiranda) flags.push("Miranda term detected");
  if (hasWarrant) flags.push("Warrant term detected");
  if (hasArraign) flags.push("Arraignment term detected");
  if (hasPlea) flags.push("Plea term detected");
  if (hasBond) flags.push("Bond term detected");

  if (flags.length) {
    findings.push({
      title: "Key terms detected",
      severity: "info",
      claim: "The record contains one or more high-signal legal procedure terms. This is a keyword-level observation for research.",
      evidence: [{ bullets: flags.map((s) => `• ${s}`) }],
    });
  }

  // Dates (very rough): look for YYYY-MM-DD or MM/DD/YYYY patterns
  const dateHits = new Set<string>();
  const iso = t.match(/\b(19|20)\d{2}-\d{2}-\d{2}\b/g) || [];
  const us = t.match(/\b\d{1,2}\/\d{1,2}\/(19|20)\d{2}\b/g) || [];
  [...iso, ...us].slice(0, 25).forEach((d) => dateHits.add(d));

  if (dateHits.size) {
    findings.push({
      title: "Potential date markers",
      severity: "info",
      claim: "The record includes date-like strings that may help anchor a timeline (unverified).",
      evidence: [{ bullets: Array.from(dateHits).slice(0, 15).map((d) => `• ${d}`) }],
    });
  }

  // Very basic length sanity
  if (len < 800) {
    findings.push({
      title: "Low extracted text volume",
      severity: "warn",
      claim: "Extracted text volume is low; the PDF may be scanned images or extraction may be incomplete.",
      evidence: [{ bullets: [`Extracted length is only ${len.toLocaleString()} chars.`] }],
    });
  }

  // Cap
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

    const kind = String(body?.kind ?? u.searchParams.get("kind") ?? "case_fact_audit").trim() || "case_fact_audit";
    const maxFindings = clamp(asInt(body?.maxFindings, 25), 1, 100);

    if (!documentToken) return json(400, { ok: false, phase: "input", error: "document_id is required" });

    const supabase = createClient(mustEnv("NEXT_PUBLIC_SUPABASE_URL"), mustEnv("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false },
    });

    // FIX: load by UUID OR external_id token
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

    // Authz
    if (auth.mode === "user" && doc.owner_id && doc.owner_id !== auth.userId) {
      return json(403, { ok: false, phase: "authz", error: "Forbidden" });
    }

    const materializeCfg = body?.materialize || {};
    const chunkMaxChars = clamp(asInt(materializeCfg?.maxChars, 4000), 800, 12000);
    const maxChunks = clamp(asInt(materializeCfg?.maxChunks, 250), 1, 2000);
    const timeoutMs = clamp(asInt(materializeCfg?.timeoutMs, 45000), 5000, 120000);

    // Resolve PDF URL
    const resolved = await resolvePdfUrl(supabase, doc);
    const pdfUrl = resolved.pdfUrl;

    // Create analysis row
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
        },
      })
      .select("id")
      .single();

    if (createErr) return json(500, { ok: false, phase: "create_analysis", error: createErr.message });

    const analysisId = String(created.id);

    // Fetch + parse PDF
    if (!pdfUrl) {
      return NextResponse.json(
        { ok: false, error: "No PDF URL resolved for document", phase: "resolve_pdf_url" },
        { status: 400 }
      );
    }

    const pdfBuf = await fetchBinaryPdf(pdfUrl, timeoutMs);
    const maxBytes = 25 * 1024 * 1024;
    if (pdfBuf.length > maxBytes) {
      await supabase
        .from("analyses")
        .update({ status: "error", error: `PDF too large (${pdfBuf.length} bytes)` })
        .eq("id", analysisId);
      return json(413, { ok: false, phase: "pdf_size", error: `PDF too large (${pdfBuf.length} bytes)`, analysisId });
    }
    // Materialize PDF to chunks using pdfjs route, then load chunks as text
    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || process.env.VERCEL_URL || "http://localhost:3000";
    const origin = baseUrl.startsWith("http") ? baseUrl : `https://${baseUrl}`;
    const ingestSecret = process.env.INGEST_SECRET || "";
    if (!ingestSecret) throw new Error("Missing INGEST_SECRET for internal materialize call");

    await ensureMaterialized(origin, doc.id, ingestSecret, timeoutMs);

    const chunksRes = await supabase
      .from("chunks")
      .select("chunk_index, content")
      .eq("document_id", doc.id)
      .order("chunk_index", { ascending: true });

    if (chunksRes.error) throw new Error(`Failed to load chunks: ${chunksRes.error.message}`);

    const text = normalizeText((chunksRes.data || []).map((r: any) => String(r.content || "")).join("\n\n"));
    if (!text) {
      await supabase
        .from("analyses")
        .update({ status: "error", error: "Materialized but no text extracted" })
        .eq("id", analysisId);

      return NextResponse.json(
        { ok: false, error: "Materialized but no text extracted" },
        { status: 422, headers: { "Cache-Control": "no-store" } }
      );
    }
const chunksText = chunkText(text, chunkMaxChars).slice(0, maxChunks);

    // Replace chunks
    const { error: delErr } = await supabase.from("chunks").delete().eq("document_id", documentId);
    if (delErr) {
      await supabase.from("analyses").update({ status: "error", error: delErr.message }).eq("id", analysisId);
      return json(500, { ok: false, phase: "delete_chunks", error: delErr.message, analysisId });
    }

    const rows = chunksText.map((content, i) => ({ document_id: documentId, chunk_index: i, content }));
    const batchSize = 200;

    for (let i = 0; i < rows.length; i += batchSize) {
      const { error: insErr } = await supabase.from("chunks").insert(rows.slice(i, i + batchSize));
      if (insErr) {
        await supabase.from("analyses").update({ status: "error", error: insErr.message }).eq("id", analysisId);
        return json(500, { ok: false, phase: "insert_chunks", error: insErr.message, analysisId });
      }
    }

    // Generate findings
    const findings = runDeterministicAudit(text, maxFindings);

    // Best-effort write to findings table; fallback to meta.findings
    let findingsWriteMode: "table" | "meta" = "meta";
    try {
      const { error: fErr } = await supabase.from("findings").insert(
        findings.map((f) => ({
          analysis_id: analysisId,
          title: f.title,
          severity: f.severity,
          claim: f.claim,
          evidence: f.evidence,
        }))
      );
      if (!fErr) findingsWriteMode = "table";
    } catch {
      findingsWriteMode = "meta";
    }

    const elapsedMs = Date.now() - startedAt;

    await supabase
      .from("analyses")
      .update({
        status: "completed",
        error: null,
        summary: `Extracted ${rows.length} chunks and generated ${findings.length} findings.`,
        meta:
          findingsWriteMode === "meta"
            ? {
                kind,
                source: "materialize-and-run",
                pdf_url: pdfUrl,
                pdf_resolved_from: resolved.source,
                elapsed_ms: elapsedMs,
                chunk_count: rows.length,
                findings,
              }
            : {
                kind,
                source: "materialize-and-run",
                pdf_url: pdfUrl,
                pdf_resolved_from: resolved.source,
                elapsed_ms: elapsedMs,
                chunk_count: rows.length,
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
      findingsWriteMode,
    });
  } catch (e: any) {
    return json(500, { ok: false, phase: "exception", error: e?.message || String(e) });
  }
}













