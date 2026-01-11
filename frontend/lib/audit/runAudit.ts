// frontend/lib/audit/runAudit.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { runAuditEngine } from "./auditEngine";

type UUID = string;

function asInt(v: any, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export type RunAuditInput = {
  analysisId: UUID;
  targetDocumentId: UUID;

  kind?: string;

  // Chunk loading
  limit?: number;

  // Engine options
  maxFindings?: number;
  excerptMaxChars?: number;

  // Pass-through meta
  meta?: any;
};

export type RunAuditResult = {
  ok: true;
  analysisId: UUID;
  target_document_id: UUID;
  chunks_loaded: number;
  inserted_findings: number;
  summary: string;
};

function looksLikeJsonChunk(content: string) {
  const s = String(content || "").trim();
  return s.startsWith("{") || s.startsWith("[");
}

/**
 * Shared audit runner (used by both system and user routes).
 * Assumes caller already handled auth.
 */
export async function runAudit(
  supabase: SupabaseClient,
  input: RunAuditInput
): Promise<RunAuditResult> {
  const analysisId = input.analysisId;
  const targetDocumentId = input.targetDocumentId;

  const kind = (input.kind || "case_fact_audit").trim() || "case_fact_audit";

  const limit = clamp(asInt(input.limit, 80), 1, 200);
  const maxFindings = clamp(asInt(input.maxFindings, 25), 1, 200);
  const excerptMaxChars = clamp(asInt(input.excerptMaxChars, 900), 200, 6000);

  // 1) Mark analysis running
  {
    const { error } = await supabase
      .from("analyses")
      .update({
        status: "running",
        target_document_id: targetDocumentId,
      })
      .eq("id", analysisId);

    if (error) {
      throw new Error(`set_running: ${error.message}`);
    }
  }

  // 2) Load chunks
  const { data: ch, error: chErr } = await supabase
    .from("chunks")
    .select("document_id,chunk_index,content")
    .eq("document_id", targetDocumentId)
    .order("chunk_index", { ascending: true })
    .limit(limit);

  if (chErr) throw new Error(`load_chunks: ${chErr.message}`);

  const chunks =
    (ch as any[])?.map((r) => ({
      document_id: String(r.document_id),
      chunk_index: Number(r.chunk_index),
      content: String(r.content || ""),
    })) ?? [];

  // 3) No chunks => insert neutral finding, finalize
  if (!chunks.length) {
    const { error: insErr } = await supabase.from("analysis_findings").insert([
      {
        analysis_id: analysisId,
        kind,
        severity: "error",
        title: "No chunks found for target",
        claim:
          "No text chunks were available for this document. Materialization and chunking may not have run yet.",
        evidence: [],
        meta: { target_document_id: targetDocumentId },
      },
    ]);

    if (insErr) throw new Error(`insert_findings: ${insErr.message}`);

    const summary = `Ran ${kind}. target_document_id=${targetDocumentId}. chunks_loaded=0. findings_inserted=1.`;

    const { error: finErr } = await supabase
      .from("analyses")
      .update({
        status: "done",
        summary,
        meta: {
          ...(input.meta || {}),
          kind,
          maxFindings,
          excerptMaxChars,
          chunks_loaded: 0,
          findings_inserted: 1,
          target_document_id: targetDocumentId,
        },
      })
      .eq("id", analysisId);

    if (finErr) throw new Error(`finalize: ${finErr.message}`);

    return {
      ok: true,
      analysisId,
      target_document_id: targetDocumentId,
      chunks_loaded: 0,
      inserted_findings: 1,
      summary,
    };
  }

  // 4) Materialization guard: if chunks are basically JSON blobs, stop early
  if (chunks.every((c) => looksLikeJsonChunk(c.content))) {
    const { error: insErr } = await supabase.from("analysis_findings").insert([
      {
        analysis_id: analysisId,
        kind,
        severity: "warning",
        title: "Materialization required",
        claim:
          "Chunks appear to contain metadata rather than extracted PDF text. Run the document materialization step to extract full text before auditing.",
        evidence: chunks.slice(0, 2).map((c) => ({
          document_id: c.document_id,
          chunk_index: c.chunk_index,
          excerpt: c.content.slice(0, 800),
        })),
        meta: {
          target_document_id: targetDocumentId,
          hint: "POST /api/documents/:id/materialize",
        },
      },
    ]);

    if (insErr) throw new Error(`insert_findings: ${insErr.message}`);

    const summary = `Ran ${kind}. target_document_id=${targetDocumentId}. chunks_loaded=${chunks.length}. findings_inserted=1 (materialization_required).`;

    const { error: finErr } = await supabase
      .from("analyses")
      .update({
        status: "done",
        summary,
        meta: {
          ...(input.meta || {}),
          kind,
          maxFindings,
          excerptMaxChars,
          chunks_loaded: chunks.length,
          findings_inserted: 1,
          target_document_id: targetDocumentId,
          materialization_required: true,
        },
      })
      .eq("id", analysisId);

    if (finErr) throw new Error(`finalize: ${finErr.message}`);

    return {
      ok: true,
      analysisId,
      target_document_id: targetDocumentId,
      chunks_loaded: chunks.length,
      inserted_findings: 1,
      summary,
    };
  }

  // 5) Run deterministic engine
  const engineFindings = runAuditEngine({
    chunks,
    options: {
      kind,
      maxFindings,
      excerptMaxChars,
    },
  });

  // 6) Insert findings
  const rows = engineFindings.map((f) => ({
    analysis_id: analysisId,
    kind: f.kind,
    severity: f.severity,
    title: f.title,
    claim: f.claim,
    evidence: f.evidence,
    meta: {
      ...f.meta,
      category: f.category,
      confidence: f.confidence,
      target_document_id: targetDocumentId,
    },
  }));

  const { error: insErr } = await supabase.from("analysis_findings").insert(rows);
  if (insErr) throw new Error(`insert_findings: ${insErr.message}`);

  const summary =
    `Ran ${kind}. target_document_id=${targetDocumentId}. ` +
    `chunks_loaded=${chunks.length}. findings_inserted=${rows.length}.`;

  // 7) Finalize
  const { error: finErr } = await supabase
    .from("analyses")
    .update({
      status: "done",
      summary,
      meta: {
        ...(input.meta || {}),
        kind,
        maxFindings,
        excerptMaxChars,
        chunks_loaded: chunks.length,
        findings_inserted: rows.length,
        target_document_id: targetDocumentId,
      },
    })
    .eq("id", analysisId);

  if (finErr) throw new Error(`finalize: ${finErr.message}`);

  return {
    ok: true,
    analysisId,
    target_document_id: targetDocumentId,
    chunks_loaded: chunks.length,
    inserted_findings: rows.length,
    summary,
  };
}
