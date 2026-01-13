// frontend/app/api/documents/[id]/materialize/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

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

function asInt(v: any, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function safeStr(v: any, max = 4000) {
  if (typeof v !== "string") return "";
  const t = v.trim();
  if (!t) return "";
  return t.length > max ? t.slice(0, max) : t;
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

function isHttpUrl(v: string) {
  return /^https?:\/\//i.test(v || "");
}

/* -------------------------------- auth -------------------------------- */

type Auth =
  | { ok: true; mode: "system"; userId: null }
  | { ok: true; mode: "user"; userId: string }
  | { ok: false; status: number; error: string };

async function requireSystemOrUser(req: Request): Promise<Auth> {
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

function dbAdmin() {
  return createClient(
    mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
    mustEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } }
  );
}

/* ------------------------ document lookup ------------------------ */
/**
 * [id] can be:
 *  - documents.id (uuid)
 *  - documents.external_id (url:..., storage:..., etc)
 */
async function loadDocumentByIdOrExternalId(admin: any, token: string) {
  const sel = "id, owner_id, raw, title, external_id";
  const t = String(token || "").trim();
  if (!t) return { doc: null as any, error: "Missing document identifier" };

  if (isUuid(t)) {
    const r = await admin.from("documents").select(sel).eq("id", t).maybeSingle();
    if (r.error) return { doc: null as any, error: r.error.message };
    if (r.data) return { doc: r.data, error: null as any };
  }

  const r2 = await admin.from("documents").select(sel).eq("external_id", t).maybeSingle();
  if (r2.error) return { doc: null as any, error: r2.error.message };
  return { doc: r2.data || null, error: null as any };
}

/* ---------------------- resolve PDF source ---------------------- */

type ResolvedPdf =
  | { kind: "http"; url: string; resolvedFrom: string }
  | { kind: "storage"; bucket: string; path: string; resolvedFrom: string };

function pickPdfCandidate(raw: any): string {
  const cands = [raw?.pdf_url, raw?.pdfUrl, raw?.pdf, raw?.url]
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter(Boolean);

  for (const c of cands) if (isHttpUrl(c)) return c;
  return cands[0] || "";
}

async function resolvePdfSource(admin: any, doc: any): Promise<ResolvedPdf> {
  const raw = doc?.raw || {};

  // 1) uploads: raw.storage_bucket + raw.storage_path
  const bucket = safeStr(raw?.storage_bucket || raw?.storageBucket, 128);
  const path = safeStr(raw?.storage_path || raw?.storagePath, 1200);
  if (bucket && path) {
    return { kind: "storage", bucket, path, resolvedFrom: "documents.raw.storage_*" };
  }

  // 2) external URL in raw.pdf_url/pdf/url
  const first = pickPdfCandidate(raw);
  if (isHttpUrl(first)) return { kind: "http", url: first, resolvedFrom: "documents.raw.*url" };

  // 3) allow pointer to another documents row by UUID (legacy)
  if (isUuid(first)) {
    const r = await admin.from("documents").select("id, raw").eq("id", first).maybeSingle();
    if (r.error) throw new Error(`PDF pointer lookup failed: ${r.error.message}`);
    if (!r.data) throw new Error(`PDF pointer document not found: ${first}`);

    const refRaw = r.data.raw || {};
    const b2 = safeStr(refRaw?.storage_bucket || refRaw?.storageBucket, 128);
    const p2 = safeStr(refRaw?.storage_path || refRaw?.storagePath, 1200);
    if (b2 && p2) {
      return { kind: "storage", bucket: b2, path: p2, resolvedFrom: "pointer:documents.id -> raw.storage_*" };
    }

    const refFirst = pickPdfCandidate(refRaw);
    if (isHttpUrl(refFirst)) {
      return { kind: "http", url: refFirst, resolvedFrom: "pointer:documents.id -> raw.*url" };
    }

    throw new Error(`PDF pointer resolved, but no usable source found (storage_* or http url).`);
  }

  throw new Error(
    `Document has no usable PDF source. Expected raw.pdf_url (http) OR raw.storage_bucket+raw.storage_path.`
  );
}

/* --------------------------- fetch bytes --------------------------- */

async function fetchBinaryPdfHttp(url: string, timeoutMs: number) {
  if (!isHttpUrl(url)) throw new Error(`Resolved PDF value is not an http(s) URL: ${url}`);

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

async function fetchBinaryPdfFromStorage(admin: any, bucket: string, path: string) {
  // Service role can download from private bucket
  const dl = await admin.storage.from(bucket).download(path);
  if (dl.error) throw new Error(`Storage download failed: ${dl.error.message}`);

  const ab = await dl.data.arrayBuffer();
  const buf = Buffer.from(ab);

  const prefix = buf.slice(0, 5).toString("utf8");
  if (prefix !== "%PDF-") {
    const head = buf.slice(0, 160).toString("utf8").replace(/\s+/g, " ").trim();
    throw new Error(`Storage content is not a PDF (missing %PDF-). First bytes: "${head}"`);
  }

  return buf;
}

/* ---------------------- pdfjs text extraction helper ---------------------- */

async function extractPdfText(pdfBytes: Uint8Array): Promise<string> {
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

/* ---------------------------------- route ---------------------------------- */

export async function POST(req: Request, ctx: { params: { id: string } }) {
  try {
    const auth = await requireSystemOrUser(req);
    if (!auth.ok) return json(auth.status, { ok: false, error: auth.error });

    const admin = dbAdmin();

    const token = String(ctx?.params?.id || "").trim();
    const body = await req.json().catch(() => ({}));

    const materializeCfg = body?.materialize || {};
    const chunkMaxChars = clamp(asInt(materializeCfg?.maxChars, 4000), 800, 12000);
    const maxChunks = clamp(asInt(materializeCfg?.maxChunks, 250), 1, 2000);
    const timeoutMs = clamp(asInt(materializeCfg?.timeoutMs, 45000), 5000, 120000);

    const { doc, error: loadErr } = await loadDocumentByIdOrExternalId(admin, token);
    if (loadErr) return json(500, { ok: false, phase: "load_document", error: loadErr });
    if (!doc) return json(404, { ok: false, phase: "load_document", error: "Document not found", identifier: token });

    // Owner check for real users (system bypass)
    if (auth.mode === "user" && doc.owner_id && doc.owner_id !== auth.userId) {
      return json(403, { ok: false, phase: "authz", error: "Forbidden" });
    }

    const resolved = await resolvePdfSource(admin, doc);

    const maxBytes = 25 * 1024 * 1024;

    let pdfBuf: Buffer;
    if (resolved.kind === "http") {
      pdfBuf = await fetchBinaryPdfHttp(resolved.url, timeoutMs);
    } else {
      pdfBuf = await fetchBinaryPdfFromStorage(admin, resolved.bucket, resolved.path);
    }

    if (pdfBuf.length > maxBytes) {
      return json(413, { ok: false, phase: "pdf_size", error: `PDF too large (${pdfBuf.length} bytes)` });
    }

    const extracted = await extractPdfText(pdfBuf);
    const text = normalizeText(extracted || "");
    if (!text) return json(422, { ok: false, phase: "parse_pdf", error: "Parsed but no text extracted" });

    const chunksText = chunkText(text, chunkMaxChars).slice(0, maxChunks);

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
      pdf_source:
        resolved.kind === "http"
          ? { kind: "http", url: resolved.url }
          : { kind: "storage", bucket: resolved.bucket, path: resolved.path },
      pdf_resolved_from: resolved.resolvedFrom,
      chunk_count: rows.length,
    });
  } catch (e: any) {
    return json(500, { ok: false, phase: "exception", error: e?.message || String(e) });
  }
}