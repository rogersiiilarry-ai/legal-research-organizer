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
async function fetchBinaryPdf(url: string, timeoutMs: number) {
  if (!isHttpUrl(url)) throw new Error(`Resolved PDF value is not a URL: ${url}`);

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ac.signal,
      cache: "no-store",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; legal-research-organizer/1.0; +pdf-materializer)",
        Accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`PDF fetch failed (${res.status}). Body starts: ${body.slice(0, 240)}`);
    }

    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);

    const prefix = buf.slice(0, 5).toString("utf8");
    if (prefix !== "%PDF-") {
      const head = buf.slice(0, 120).toString("utf8").replace(/\s+/g, " ").trim();
      throw new Error(
        `Fetched content is not a PDF (missing %PDF- header). First bytes look like: "${head}"`
      );
    }

    return buf;
  } finally {
    clearTimeout(t);
  }
}

async function parsePdf(buffer: Buffer) {
  const req = createRequire(import.meta.url);

  let mod: any;
  try {
    mod = req("pdf-parse");
  } catch (e: any) {
    throw new Error(`Failed to load pdf-parse. Run: npm i pdf-parse. Last error: ${e?.message || e}`);
  }

  const fn = mod?.default ?? mod;
  if (typeof fn !== "function") throw new Error("pdf-parse did not export a callable function");
  return await fn(buffer);
}

/* -------------------------- deterministic audit ------------------------- */

function runDeterministicAudit(text: string, maxFindings = 25) {
  const findings: any[] = [];

  const words = text
    .replace(/[^\w\s\/\-:,.]/g, " ")
    .split(/\s+/g)
    .filter(Boolean);

  const entityCounts = new Map<string, number>();
  for (const w of words) {
    if (w.length < 3) continue;
    if (!/[A-Za-z]/.test(w)) continue;

    const looksEntity = /^[A-Z][a-z]/.test(w) || /^[A-Z0-9\-]{3,}$/.test(w);
    if (!looksEntity) continue;

    const key = w.replace(/[,.:;]+$/, "");
    entityCounts.set(key, (entityCounts.get(key) || 0) + 1);
  }

  const topEntities = [...entityCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([k, v]) => ({ term: k, count: v }));

  const dateMatches =
    text.match(/\b(\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})\b/g) || [];
  const uniqueDates = [...new Set(dateMatches)].slice(0, 25);

  findings.push({
    title: "Record text extracted",
    severity: "info",
    claim: `Text was extracted and is suitable for analysis. Length: ${text.length.toLocaleString()} chars.`,
    evidence: { length_chars: text.length },
  });

  findings.push({
    title: "Top referenced entities (names/terms)",
    severity: "info",
    claim: topEntities.length
      ? "Most frequent entities/terms were extracted for quick review."
      : "No strong entity signals detected in extracted text.",
    evidence: { topEntities },
  });

  findings.push({
    title: "Detected dates (timeline anchors)",
    severity: uniqueDates.length ? "info" : "warn",
    claim: uniqueDates.length
      ? `Detected ${uniqueDates.length} distinct date tokens that can anchor a timeline review.`
      : "No date tokens were detected; timeline reconstruction may require scanned/OCR content.",
    evidence: { dates: uniqueDates },
  });

  const nonTrivialWordCount = words.filter((w) => w.length >= 4).length;
  findings.push({
    title: "Coverage / density signal",
    severity: nonTrivialWordCount > 2000 ? "info" : "warn",
    claim:
      nonTrivialWordCount > 2000
        ? "Document has substantial text content; higher confidence for automated consistency checks."
        : "Document text content is relatively thin; findings may be limited without more pages or OCR.",
    evidence: { word_count_4plus: nonTrivialWordCount },
  });

  return findings.slice(0, maxFindings);
}

/* --------------------- resolve pdf url robustly -------------------- */

function pickPdfCandidate(raw: any): string {
  const cands = [raw?.pdf_url, raw?.pdfUrl, raw?.pdf, raw?.url]
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter(Boolean);

  for (const c of cands) if (isHttpUrl(c)) return c;
  return cands[0] || "";
}

async function resolvePdfUrl(supabase: any, doc: any) {
  const raw = doc?.raw || {};
  const first = pickPdfCandidate(raw);

  if (isHttpUrl(first)) return { pdfUrl: first, resolvedFrom: "self:url" as const };

  // If doc.raw.pdf is a UUID pointer to another documents row
  if (isUuid(first)) {
    const { data: ref, error } = await supabase
      .from("documents")
      .select("id, raw")
      .eq("id", first)
      .maybeSingle();

    if (error) throw new Error(`PDF pointer lookup failed: ${error.message}`);
    if (!ref) throw new Error(`PDF pointer document not found: ${first}`);

    const refFirst = pickPdfCandidate(ref.raw || {});
    if (!isHttpUrl(refFirst)) throw new Error(`PDF pointer resolved, but still not a URL: ${refFirst || "(empty)"}`);

    return { pdfUrl: refFirst, resolvedFrom: "pointer:documents.id" as const };
  }

  throw new Error(
    `Document has no usable PDF URL. Expected raw.pdf_url/raw.pdf to be an http(s) URL, but got: ${first || "(empty)"}`
  );
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
          pdf_resolved_from: resolved.resolvedFrom,
          document_identifier: documentToken,
        },
      })
      .select("id")
      .single();

    if (createErr) return json(500, { ok: false, phase: "create_analysis", error: createErr.message });

    const analysisId = String(created.id);

    // Fetch + parse PDF
    const pdfBuf = await fetchBinaryPdf(pdfUrl, timeoutMs);

    const maxBytes = 25 * 1024 * 1024;
    if (pdfBuf.length > maxBytes) {
      await supabase
        .from("analyses")
        .update({ status: "error", error: `PDF too large (${pdfBuf.length} bytes)` })
        .eq("id", analysisId);
      return json(413, { ok: false, phase: "pdf_size", error: `PDF too large (${pdfBuf.length} bytes)`, analysisId });
    }

    const parsed = await parsePdf(pdfBuf);
    const text = normalizeText(parsed?.text || "");
    if (!text) {
      await supabase.from("analyses").update({ status: "error", error: "Parsed but no text extracted" }).eq("id", analysisId);
      return json(422, { ok: false, phase: "parse_pdf", error: "Parsed but no text extracted", analysisId });
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
                pdf_resolved_from: resolved.resolvedFrom,
                elapsed_ms: elapsedMs,
                chunk_count: rows.length,
                findings,
              }
            : {
                kind,
                source: "materialize-and-run",
                pdf_url: pdfUrl,
                pdf_resolved_from: resolved.resolvedFrom,
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
      pdf_resolved_from: resolved.resolvedFrom,
      chunk_count: rows.length,
      findingsCount: findings.length,
      findingsWriteMode,
    });
  } catch (e: any) {
    return json(500, { ok: false, phase: "exception", error: e?.message || String(e) });
  }
}
