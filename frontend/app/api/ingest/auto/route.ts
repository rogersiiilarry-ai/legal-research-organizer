// frontend/app/api/ingest/auto/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

type JsonValue = any;

function json(status: number, payload: JsonValue) {
  return NextResponse.json(payload, { status });
}

function isObject(v: any): v is Record<string, any> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function safeString(v: any): string {
  return typeof v === "string" ? v : "";
}

function trimOrNull(v: any): string | null {
  const s = safeString(v).trim();
  return s ? s : null;
}

function clampInt(v: any, min: number, max: number, dflt: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function getBaseUrl(req: Request) {
  const proto = req.headers.get("x-forwarded-proto") || "http";
  const host =
    req.headers.get("x-forwarded-host") ||
    req.headers.get("host") ||
    "127.0.0.1:3000";
  return `${proto}://${host}`;
}

/**
 * Build payload for /api/search from job config + runtime note.
 * Priority for q:
 *  1) payload.q (config.search.q or config.q)
 *  2) cfg.q
 *  3) note
 */
function buildSearchPayload(cfg: any, note: string | null) {
  const base = isObject(cfg) && isObject(cfg.search) ? cfg.search : cfg;
  if (!isObject(base)) {
    return { ok: false as const, error: "Job config is not an object." };
  }

  const payload: Record<string, any> = { ...base };

  const qFinal =
    trimOrNull(payload.q) ||
    trimOrNull(isObject(cfg) ? cfg.q : null) ||
    trimOrNull(note);

  if (!qFinal) {
    return {
      ok: false as const,
      error:
        'Missing query. Add config.q (or config.search.q) in source_jobs, or call ingest with { "note": "..." }.',
    };
  }

  payload.q = qFinal;

  // defaults expected by /api/search
  if (!trimOrNull(payload.mode)) payload.mode = "topic";
  if (!trimOrNull(payload.sort)) payload.sort = "dateFiled_desc";
  payload.limit = clampInt(payload.limit, 1, 50, 50);

  // inherit region from cfg root if payload lacks it
  if (!trimOrNull(payload.region) && isObject(cfg) && trimOrNull(cfg.region)) {
    payload.region = cfg.region;
  }

  return { ok: true as const, payload };
}

/**
 * Your documents columns (from your screenshot):
 * id, external_source, external_id, title, collection, date_issued, raw,
 * created_at, source_id, source, jurisdiction, court, published_at, date_filed
 */
function buildDocumentRow(args: {
  external_source: string;
  d: any;
  payload: any;
}) {
  const { external_source, d, payload } = args;

  // external_id: strong fallbacks (PDF providers may not have id fields)
  const external_id =
    trimOrNull(d?.external_id) ||
    trimOrNull(d?.id) ||
    trimOrNull(d?.cluster_id) ||
    trimOrNull(d?.opinion_id) ||
    trimOrNull(d?.opinionId) ||
    trimOrNull(d?.slug) ||
    trimOrNull(d?.url) ||
    trimOrNull(d?.absolute_url) ||
    trimOrNull(d?.pdf);

  if (!external_id) return { ok: false as const, reason: "missing_external_id" };

  const title =
    trimOrNull(d?.title) ||
    trimOrNull(d?.caseName) ||
    trimOrNull(d?.case_name) ||
    trimOrNull(d?.caption) ||
    trimOrNull(d?.name) ||
    null;

  const court =
    trimOrNull(d?.court) ||
    trimOrNull(d?.court_name) ||
    trimOrNull(d?.courtId) ||
    trimOrNull(d?.court_id) ||
    null;

  const date_filed =
    trimOrNull(d?.date_filed) ||
    trimOrNull(d?.dateFiled) ||
    trimOrNull(d?.filed_at) ||
    null;

  const published_at =
    trimOrNull(d?.published_at) ||
    trimOrNull(d?.publishedAt) ||
    trimOrNull(d?.date_published) ||
    null;

  const date_issued =
    trimOrNull(d?.date_issued) ||
    trimOrNull(d?.dateIssued) ||
    trimOrNull(d?.issued_at) ||
    published_at ||
    null;

  const collection = trimOrNull(payload?.provider) || external_source;

  const jurisdiction =
    trimOrNull(d?.jurisdiction) || trimOrNull(payload?.region) || null;

  const source = trimOrNull(d?.source) || external_source;
  const source_id = d?.source_id ?? null;

  const row: Record<string, any> = {
    external_source,
    external_id,
    title,
    collection,
    date_issued,
    raw: d,

    source_id,
    source,
    jurisdiction,
    court,
    published_at,
    date_filed,
  };

  return { ok: true as const, external_id, row };
}

/**
 * rpc_chunk_document signature in your DB:
 * rpc_chunk_document(p_document_id uuid, p_max_chars integer DEFAULT 1200)
 */
async function chunkDocument(
  supabaseAdmin: any,
  documentId: string,
  maxChars = 1200
) {
  const attempts: Array<Record<string, any>> = [
    { p_document_id: documentId, p_max_chars: maxChars }, // correct signature
    { p_document_id: documentId }, // rely on default p_max_chars
  ];

  const errors: any[] = [];

  for (const args of attempts) {
    const { error } = await supabaseAdmin.rpc("rpc_chunk_document", args);
    if (!error) return { ok: true as const };
    errors.push({
      args: Object.keys(args),
      message: error.message,
      details: (error as any).details,
      hint: (error as any).hint,
      code: (error as any).code,
    });
  }

  return { ok: false as const, errors };
}

export async function POST(req: Request) {
  // 1) Ingest auth gate
  const provided = req.headers.get("x-ingest-secret") || "";
  const expected = process.env.INGEST_SECRET || "";
  if (!expected) return json(500, { ok: false, phase: "auth", error: "Missing INGEST_SECRET" });
  if (provided !== expected) return json(401, { ok: false, phase: "auth", error: "Unauthorized" });

  // 2) Parse body
  let body: any = {};
  try {
    body = await req.json().catch(() => ({}));
  } catch {
    body = {};
  }

  const maxJobs = clampInt(body?.maxJobs, 1, 25, 1);
  const note = typeof body?.note === "string" ? body.note : null;

  // 3) Supabase admin client
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl) return json(500, { ok: false, phase: "supabase-init", error: "Missing NEXT_PUBLIC_SUPABASE_URL" });
  if (!serviceKey) return json(500, { ok: false, phase: "supabase-init", error: "Missing SUPABASE_SERVICE_ROLE_KEY" });

  const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
    global: { headers: { "x-application-name": "legal-research-organizer" } },
  });

  // 4) Load enabled jobs
  const { data: jobs, error: jobsError } = await supabaseAdmin
    .from("source_jobs")
    .select("*")
    .eq("enabled", true)
    .order("created_at", { ascending: false })
    .limit(maxJobs);

  if (jobsError) return json(500, { ok: false, phase: "load-jobs", error: jobsError.message });
  if (!jobs || jobs.length === 0) return json(200, { ok: true, phase: "load-jobs", jobs: 0, message: "No enabled jobs" });

  const baseUrl = getBaseUrl(req);
  const results: any[] = [];

  for (const job of jobs) {
    const jobId = job.id;
    const startedIso = new Date().toISOString();

    // 5) Create run row
    const { data: runRow, error: runErr } = await supabaseAdmin
      .from("source_job_runs")
      .insert({
        job_id: jobId,
        started_at: startedIso,
        finished_at: null,
        ok: false,
        fetched_count: 0,
        inserted_docs: 0,
        chunked_docs: 0,
        note,
        meta: { phase: "start" },
      })
      .select("*")
      .single();

    if (runErr) {
      results.push({ jobId, ok: false, phase: "job-run-create", error: runErr.message });
      continue;
    }

    const runId = runRow.id;

    const finalizeRun = async (args: {
      ok: boolean;
      fetched: number;
      upserted: number;
      chunked: number;
      meta?: any;
    }) => {
      const finishedIso = new Date().toISOString();
      await supabaseAdmin
        .from("source_job_runs")
        .update({
          finished_at: finishedIso,
          ok: args.ok,
          fetched_count: args.fetched,
          inserted_docs: args.upserted, // keeping your column name, but itâ€™s â€œupsertedâ€
          chunked_docs: args.chunked,
          meta: args.meta ?? null,
        })
        .eq("id", runId);
    };

    try {
      // 6) Build /api/search payload
      const cfg = job.config;
      const built = buildSearchPayload(cfg, note);
      if (!built.ok) {
        await finalizeRun({ ok: false, fetched: 0, upserted: 0, chunked: 0, meta: { phase: "config", error: built.error } });
        results.push({ jobId, runId, ok: false, phase: "config", error: built.error });
        continue;
      }

      const payload = built.payload;
      const external_source = trimOrNull(payload.provider) || "courtlistener";

      // 7) Call internal search API
      const searchResp = await fetch(`${baseUrl}/api/search`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ingest-secret": expected },
        body: JSON.stringify(payload),
      });

      const rawText = await searchResp.text().catch(() => "");
      if (!searchResp.ok) {
        const msg = `Search failed (${searchResp.status}): ${rawText.slice(0, 900)}`;
        await finalizeRun({
          ok: false,
          fetched: 0,
          upserted: 0,
          chunked: 0,
          meta: { phase: "search", error: msg, payloadPreview: { q: payload.q, provider: payload.provider, region: payload.region } },
        });
        results.push({ jobId, runId, ok: false, phase: "search", error: msg });
        continue;
      }

      let searchJson: any;
      try {
        searchJson = JSON.parse(rawText);
      } catch {
        const msg = `Search returned non-JSON: ${rawText.slice(0, 300)}`;
        await finalizeRun({ ok: false, fetched: 0, upserted: 0, chunked: 0, meta: { phase: "search", error: msg } });
        results.push({ jobId, runId, ok: false, phase: "search", error: msg });
        continue;
      }

      const docs = Array.isArray(searchJson?.results)
        ? searchJson.results
        : Array.isArray(searchJson?.items)
        ? searchJson.items
        : Array.isArray(searchJson)
        ? searchJson
        : [];

      let upserted = 0;
      let chunked = 0;

      let skippedNoExternalId = 0;
      const upsertErrors: any[] = [];
      const chunkErrors: any[] = [];

      for (const d of docs) {
        const builtRow = buildDocumentRow({ external_source, d, payload });
        if (!builtRow.ok) {
          skippedNoExternalId++;
          continue;
        }

        const { row, external_id } = builtRow;

        const { data: docRow, error: upErr } = await supabaseAdmin
          .from("documents")
          .upsert(row, { onConflict: "external_source,external_id" })
          .select("id")
          .single();

        if (upErr) {
          if (upsertErrors.length < 5) {
            upsertErrors.push({
              message: upErr.message,
              details: (upErr as any).details,
              hint: (upErr as any).hint,
              code: (upErr as any).code,
              external_source,
              external_id,
            });
          }
          continue;
        }

        upserted++;

        const chunkAttempt = await chunkDocument(supabaseAdmin, docRow.id, 1200);
        if (chunkAttempt.ok) {
          chunked++;
        } else {
          if (chunkErrors.length < 5) {
            chunkErrors.push({ external_source, external_id, document_id: docRow.id, attempts: chunkAttempt.errors });
          }
        }
      }

      await finalizeRun({
        ok: true,
        fetched: docs.length,
        upserted,
        chunked,
        meta: {
          phase: "done",
          payloadPreview: { q: payload.q, provider: payload.provider, region: payload.region, limit: payload.limit },
          counts: { fetched: docs.length, upserted, chunked },
          skippedNoExternalId,
          upsertErrors,
          chunkErrors,
        },
      });

      results.push({
        jobId,
        runId,
        ok: true,
        fetched: docs.length,
        upserted_docs: upserted,
        chunked_docs: chunked,
      });
    } catch (e: any) {
      const msg = e?.message || String(e);
      await finalizeRun({ ok: false, fetched: 0, upserted: 0, chunked: 0, meta: { phase: "exception", error: msg } });
      results.push({ jobId, runId, ok: false, phase: "exception", error: msg });
    }
  }

  return json(200, { ok: true, phase: "done", jobs: jobs.length, results });
}

