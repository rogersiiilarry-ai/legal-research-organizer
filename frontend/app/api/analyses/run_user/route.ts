// frontend/app/api/analyses/run_user/route.ts
import { NextResponse } from "next/server";
import { runAuditEngine } from "../../../../lib/audit/auditEngine";
import { getUserSupabase, getServiceSupabase } from "../../../../lib/supabase/serverClients";

export const runtime = "nodejs";

function json(status: number, payload: any) {
  return NextResponse.json(payload, { status });
}

function clampInt(v: any, fallback: number, min: number, max: number) {
  const n = Number(v);
  const m = Number.isFinite(n) ? Math.trunc(n) : fallback;
  return Math.max(min, Math.min(max, m));
}

function isUuid(v: any): v is string {
  if (typeof v !== "string") return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v.trim());
}

async function readJson(req: Request): Promise<any> {
  try {
    const buf = await req.arrayBuffer();
    const raw = Buffer.from(buf).toString("utf8").trim();
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  } catch {
    return {};
  }
}

export async function POST(req: Request) {
  try {
    // User auth (cookie session)
    const supaUser = getUserSupabase();
    const { data: u, error: uErr } = await supaUser.auth.getUser();
    if (uErr || !u?.user?.id) return json(401, { ok: false, phase: "auth", error: "Unauthorized" });
    const userId = u.user.id;

    const body = await readJson(req);
    const uurl = new URL(req.url);

    const analysisId = String(body?.analysisId ?? body?.analysis_id ?? body?.id ?? uurl.searchParams.get("analysisId") ?? "").trim();
    const targetDocumentId = String(
      body?.target_document_id ??
        body?.targetDocumentId ??
        body?.document_id ??
        body?.documentId ??
        uurl.searchParams.get("document_id") ??
        ""
    ).trim();

    const kind = String(body?.kind ?? body?.analysisKind ?? uurl.searchParams.get("kind") ?? "case_fact_audit").trim() || "case_fact_audit";
    const limit = clampInt(body?.limit ?? uurl.searchParams.get("limit"), 60, 1, 500);
    const excerptMaxChars = clampInt(body?.maxChars ?? body?.excerptMaxChars ?? uurl.searchParams.get("maxChars"), 1200, 200, 8000);
    const maxFindings = clampInt(body?.maxFindings ?? uurl.searchParams.get("maxFindings"), 25, 1, 300);

    if (!isUuid(analysisId)) return json(400, { ok: false, phase: "input", error: "analysisId (UUID) is required" });
    if (!targetDocumentId) return json(400, { ok: false, phase: "input", error: "target_document_id is required" });

    const supa = getServiceSupabase();

    // Load analysis + authz
    const { data: analysis, error: aErr } = await supa.from("analyses").select("*").eq("id", analysisId).maybeSingle();
    if (aErr) return json(500, { ok: false, phase: "load_analysis", error: aErr.message });
    if (!analysis) return json(404, { ok: false, phase: "load_analysis", error: "Analysis not found" });

    if (analysis.owner_id && analysis.owner_id !== userId) return json(403, { ok: false, phase: "authz", error: "Forbidden" });

    // Mark running
    const { error: upErr } = await supa
      .from("analyses")
      .update({ status: "running", target_document_id: targetDocumentId, updated_at: new Date().toISOString() })
      .eq("id", analysisId);
    if (upErr) return json(500, { ok: false, phase: "update_analysis", error: upErr.message });

    // Load chunks
    const { data: ch, error: chErr } = await supa
      .from("chunks")
      .select("document_id, chunk_index, content")
      .eq("document_id", targetDocumentId)
      .order("chunk_index", { ascending: true })
      .limit(limit);

    if (chErr) return json(500, { ok: false, phase: "load_chunks", error: chErr.message });

    const chunks = (ch || []).map((r: any) => ({
      document_id: String(r.document_id),
      chunk_index: Number(r.chunk_index),
      content: String(r.content || ""),
    }));

    if (!chunks.length) return json(422, { ok: false, phase: "load_chunks", error: "No chunks found. Materialize first." });

    const findings = runAuditEngine({ chunks, options: { kind, maxFindings, excerptMaxChars } });

    if (Array.isArray(findings) && findings.length) {
      const rows = findings.map((f: any) => ({
        analysis_id: analysisId,
        kind: String(f.kind || kind),
        severity: String(f.severity || "info"),
        title: String(f.title || "Finding"),
        claim: String(f.claim || ""),
        evidence: f.evidence ?? null,
        meta: { ...(f.meta || {}), category: f.category ?? null, confidence: f.confidence ?? null, target_document_id: targetDocumentId },
      }));

      const { error: fErr } = await supa.from("analysis_findings").insert(rows);
      if (fErr) return json(500, { ok: false, phase: "insert_findings", error: fErr.message });
    }

    const summary = `Ran ${kind} on ${Math.min(limit, chunks.length)} chunks. findings_inserted=${Array.isArray(findings) ? findings.length : 0}.`;
    const { error: finErr } = await supa
      .from("analyses")
      .update({ status: "done", summary, updated_at: new Date().toISOString() })
      .eq("id", analysisId);
    if (finErr) return json(500, { ok: false, phase: "finalize", error: finErr.message });

    return json(200, {
      ok: true,
      phase: "done",
      analysisId,
      document_id: targetDocumentId,
      kind,
      sampled_chunks: Math.min(limit, chunks.length),
      inserted_findings: Array.isArray(findings) ? findings.length : 0,
      summary,
    });
  } catch (e: any) {
    return json(500, { ok: false, phase: "exception", error: e?.message || String(e) });
  }
}
