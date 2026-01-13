import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// pdfjs ESM legacy build (Node-safe)
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

export const runtime = "nodejs";

/* ----------------------------- helpers ----------------------------- */

function json(status: number, payload: any) {
  return NextResponse.json(payload, { status });
}

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function asUuid(v: any): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return UUID_RE.test(s) ? s : null;
}

function asInt(v: any, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** system-only gate */
function requireSystem(req: Request) {
  const provided = req.headers.get("x-ingest-secret") || "";
  const expected = process.env.INGEST_SECRET || "";
  if (!expected) return { ok: false as const, status: 500, error: "Missing INGEST_SECRET" };
  if (provided !== expected) return { ok: false as const, status: 401, error: "Unauthorized" };
  return { ok: true as const };
}

function normalizeText(s: string) {
  return (s || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function chunkText(text: string, maxChars: number, maxChunks: number) {
  const t = normalizeText(text);
  if (!t) return [];

  const chunks: string[] = [];
  let i = 0;

  while (i < t.length && chunks.length < maxChunks) {
    const end = Math.min(t.length, i + maxChars);
    let sliceEnd = end;

    const window = t.slice(i, end);
    const lastBreak =
      Math.max(
        window.lastIndexOf("\n\n"),
        window.lastIndexOf("\n"),
        window.lastIndexOf(". ")
      );

    if (lastBreak > Math.floor(maxChars * 0.6)) {
      sliceEnd = i + lastBreak + 1;
    }

    const piece = normalizeText(t.slice(i, sliceEnd));
    if (piece) chunks.push(piece);
    i = sliceEnd;
  }

  return chunks;
}

async function fetchPdfBytes(url: string, timeoutMs: number) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`Failed to fetch PDF: ${res.status}`);
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  } finally {
    clearTimeout(t);
  }
}

async function extractPdfText(pdfBytes: Uint8Array) {
  // Disable worker explicitly for Node
  // @ts-ignore
  if (pdfjs.GlobalWorkerOptions) {
    // @ts-ignore
    pdfjs.GlobalWorkerOptions.workerSrc = "";
  }

  // @ts-ignore
  const loadingTask = pdfjs.getDocument({ data: pdfBytes });
  const doc = await loadingTask.promise;

  let out = "";

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const tc = await page.getTextContent();

    const pageText = (tc.items || [])
      .map((it: any) => (typeof it?.str === "string" ? it.str : ""))
      .join(" ");

    out += "\n\n" + pageText;
  }

  return normalizeText(out);
}

/* ------------------------------- POST ------------------------------- */

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> | { id: string } }
) {
  try {
    const auth = requireSystem(req);
    if (!auth.ok) return json(auth.status, { ok: false, error: auth.error });

    const supabase = createClient(
      mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
      mustEnv("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false } }
    );

    const params = await ctx.params;
    const documentId = asUuid(params?.id);
    if (!documentId) {
      return json(400, { ok: false, error: "Invalid document id (UUID required)" });
    }

    const url = new URL(req.url);
    const maxChars = Math.max(500, Math.min(12000, asInt(url.searchParams.get("maxChars"), 4000)));
    const maxChunks = Math.max(1, Math.min(2000, asInt(url.searchParams.get("maxChunks"), 250)));
    const timeoutMs = Math.max(1000, Math.min(120000, asInt(url.searchParams.get("timeoutMs"), 45000)));

    const { data: docRow, error: docErr } = await supabase
      .from("documents")
      .select("id, raw, pdf")
      .eq("id", documentId)
      .maybeSingle();

    if (docErr) return json(500, { ok: false, error: docErr.message });
    if (!docRow) return json(404, { ok: false, error: "Document not found" });

    const pdfUrl =
      (typeof (docRow as any)?.pdf === "string" && (docRow as any).pdf) ||
      (typeof (docRow as any)?.raw?.pdf_url === "string" && (docRow as any).raw.pdf_url) ||
      (typeof (docRow as any)?.raw?.pdf === "string" && (docRow as any).raw.pdf) ||
      null;

    if (!pdfUrl) {
      return json(400, {
        ok: false,
        error: "No PDF URL found (expected documents.pdf or documents.raw.pdf_url)",
      });
    }

    const pdfBytes = await fetchPdfBytes(pdfUrl, timeoutMs);
    const extracted = await extractPdfText(pdfBytes);

    if (!extracted) {
      return json(200, {
        ok: true,
        phase: "empty",
        document_id: documentId,
        chunk_count: 0,
      });
    }

    const chunks = chunkText(extracted, maxChars, maxChunks);

    await supabase.from("chunks").delete().eq("document_id", documentId);

    const rows = chunks.map((content, idx) => ({
      document_id: documentId,
      chunk_index: idx,
      content,
    }));

    const { error: insErr } = await supabase.from("chunks").insert(rows);
    if (insErr) return json(500, { ok: false, error: insErr.message });

    return json(200, {
      ok: true,
      document_id: documentId,
      extracted_chars: extracted.length,
      chunk_count: rows.length,
      maxChars,
      maxChunks,
    });
  } catch (e: any) {
    return json(500, { ok: false, error: e?.message || String(e) });
  }
}
