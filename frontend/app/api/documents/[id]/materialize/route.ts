// frontend/app/api/documents/[id]/materialize/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { createRequire } from "module";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

export const runtime = "nodejs";

/* ------------------------------- helpers ------------------------------- */

function json(status: number, payload: any) {
  return NextResponse.json(payload, { status });
}

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
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

/* -------------------------------- auth -------------------------------- */

async function requireUser() {
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
  if (error || !data?.user?.id) return { ok: false as const, status: 401, error: "Unauthorized" };
  return { ok: true as const, userId: data.user.id };
}

function dbAdmin() {
  return createClient(
    mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
    mustEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } }
  );
}

/* ------------------------ document lookup (REAL FIX) ------------------------ */
/**
 * [id] can be:
 *  - documents.id (uuid)
 *  - documents.external_id (like "url:....")
 */
async function loadDocumentByIdOrExternalId(admin: any, token: string) {
  const sel = "id, owner_id, raw, title, external_id";
  const t = String(token || "").trim();
  if (!t) return { doc: null as any, error: "Missing document identifier" };

  // UUID -> documents.id
  if (isUuid(t)) {
    const r = await admin.from("documents").select(sel).eq("id", t).maybeSingle();
    if (r.error) return { doc: null as any, error: r.error.message };
    if (r.data) return { doc: r.data, error: null as any };
  }

  // Otherwise treat as external_id
  const r = await admin.from("documents").select(sel).eq("external_id", t).maybeSingle();
  if (r.error) return { doc: null as any, error: r.error.message };
  return { doc: r.data || null, error: null as any };
}

/* --------------------------- PDF fetch + parse --------------------------- */

async function fetchBinaryPdf(url: string, timeoutMs: number) {
  if (!isHttpUrl(url)) {
    throw new Error(`Resolved PDF value is not an http(s) URL: ${url}`);
  }

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ac.signal,
      headers: { "User-Agent": "legal-research-organizer/1.0 (pdf-materializer)" },
      cache: "no-store",
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`PDF fetch failed (${res.status}): ${body.slice(0, 240)}`);
    }

    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);

    // ONLY enforce "is PDF" by signature, not content-type
    const prefix = buf.slice(0, 5).toString("utf8");
    if (prefix !== "%PDF-") {
      const head = buf.slice(0, 160).toString("utf8").replace(/\s+/g, " ").trim();
      throw new Error(`Fetched content is not a PDF (missing %PDF-). First bytes: "${head}"`);
    }

    return buf;
  } finally {
    clearTimeout(t);
  }
}
/* ---------------------- resolve PDF URL from document ---------------------- */

function pickPdfCandidate(raw: any): string {
  const cands = [raw?.pdf, raw?.pdf_url, raw?.pdfUrl, raw?.url]
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter(Boolean);

  // prefer real URL
  for (const c of cands) if (isHttpUrl(c)) return c;

  // else return first token (might be pointer)
  return cands[0] || "";
}

async function resolvePdfUrl(admin: any, doc: any) {
  const raw = doc?.raw || {};
  const first = pickPdfCandidate(raw);

  if (isHttpUrl(first)) return { pdfUrl: first, resolvedFrom: "self:url" as const };

  // If raw.pdf is a UUID pointer to another documents row
  if (isUuid(first)) {
    const r = await admin.from("documents").select("id, raw").eq("id", first).maybeSingle();
    if (r.error) throw new Error(`PDF pointer lookup failed: ${r.error.message}`);
    if (!r.data) throw new Error(`PDF pointer document not found: ${first}`);

    const refFirst = pickPdfCandidate(r.data.raw || {});
    if (!isHttpUrl(refFirst)) throw new Error(`PDF pointer resolved, but still not a URL: ${refFirst || "(empty)"}`);

    return { pdfUrl: refFirst, resolvedFrom: "pointer:documents.id" as const };
  }

  throw new Error(
    `Document has no usable PDF URL. Expected raw.pdf/raw.pdf_url to be an http(s) URL, got: ${first || "(empty)"}`
  );
}

/* ---------------------------------- route ---------------------------------- */
/* --------------------------- pdfjs text extraction helper --------------------------- */
/**
 * Extracts text from a PDF using pdfjs-dist legacy build (server-side).
 * Returns a single concatenated string (pages separated by blank lines).
 */
async function extractPdfText(pdfBytes: Uint8Array): Promise<string> {
  // In Node (Next.js route handlers), pdfjs works without setting workerSrc.
  // @ts-ignore
  const loadingTask = pdfjs.getDocument({ data: pdfBytes });
  // @ts-ignore
  const doc = await loadingTask.promise;

  let out = "";
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const tc = await page.getTextContent();

    const pageText = (tc.items || [])
      .map((it: any) => (typeof it?.str === "string" ? it.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    if (pageText) out += (out ? "\n\n" : "") + pageText;
  }

  return out;
}
export async function POST(req: Request, ctx: { params: { id: string } }) {
  try {
    const auth = await requireUser();
    if (!auth.ok) return json(auth.status, { ok: false, error: auth.error });

    const admin = dbAdmin();

    // IMPORTANT: This is the [id] segment from the URL.
    // It may be UUID or external_id (like url:xxxx)
    const token = String(ctx?.params?.id || "").trim();

    const body = await req.json().catch(() => ({}));
    const materializeCfg = body?.materialize || {};
    const chunkMaxChars = clamp(asInt(materializeCfg?.maxChars, 4000), 800, 12000);
    const maxChunks = clamp(asInt(materializeCfg?.maxChunks, 250), 1, 2000);
    const timeoutMs = clamp(asInt(materializeCfg?.timeoutMs, 45000), 5000, 120000);

    const { doc, error: loadErr } = await loadDocumentByIdOrExternalId(admin, token);
    if (loadErr) return json(500, { ok: false, phase: "load_document", error: loadErr });
    if (!doc) return json(404, { ok: false, phase: "load_document", error: "Document not found", identifier: token });

    if (doc.owner_id && doc.owner_id !== auth.userId) {
      return json(403, { ok: false, phase: "authz", error: "Forbidden" });
    }

    const resolved = await resolvePdfUrl(admin, doc);
    const pdfUrl = resolved.pdfUrl;

    const pdfBuf = await fetchBinaryPdf(pdfUrl, timeoutMs);

    const maxBytes = 25 * 1024 * 1024;
    if (pdfBuf.length > maxBytes) {
      return json(413, { ok: false, phase: "pdf_size", error: `PDF too large (${pdfBuf.length} bytes)` });
    }
    const extracted = await extractPdfText(pdfBuf);
    const text = normalizeText(extracted || "");
    if (!text) return json(422, { ok: false, phase: "parse_pdf", error: "Parsed but no text extracted" });

    const chunksText = chunkText(text, chunkMaxChars).slice(0, maxChunks);

    // Replace chunks for the REAL UUID document_id
    const documentId = String(doc.id);

    const del = await admin.from("chunks").delete().eq("document_id", documentId);
    if (del.error) return json(500, { ok: false, phase: "delete_chunks", error: del.error.message });

    const rows = chunksText.map((content, i) => ({ document_id: documentId, chunk_index: i, content }));

    const batchSize = 200;
    for (let i = 0; i < rows.length; i += batchSize) {
      const ins = await admin.from("chunks").insert(rows.slice(i, i + batchSize));
      if (ins.error) return json(500, { ok: false, phase: "insert_chunks", error: ins.error.message });
    }

    return json(200, {
      ok: true,
      document_id: documentId,
      document_identifier: token,
      pdf_url: pdfUrl,
      pdf_resolved_from: resolved.resolvedFrom,
      chunk_count: rows.length,
    });
  } catch (e: any) {
    return json(500, { ok: false, phase: "exception", error: e?.message || String(e) });
  }
}






