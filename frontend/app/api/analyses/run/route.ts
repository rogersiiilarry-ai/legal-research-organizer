// frontend/app/api/analyses/run/route.ts
import { NextResponse } from "next/server";
import { runAuditEngine } from "../../../../lib/audit/auditEngine";
import { getUserSupabase, getServiceSupabase } from "../../../../lib/supabase/serverClients";


export const runtime = "nodejs";

/** ---------------- helpers ---------------- */
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

/**
 * IMPORTANT:
 * Using arrayBuffer() is more reliable than text()/json() in some Next+Node situations.
 */
async function readJson(req: Request): Promise<{ body: any; raw: string; rawLen: number }> {
  try {
    const buf = await req.arrayBuffer();
    const raw = Buffer.from(buf).toString("utf8").trim();
    if (!raw) return { body: {}, raw: "", rawLen: 0 };
    try {
      return { body: JSON.parse(raw), raw, rawLen: raw.length };
    } catch {
      return { body: {}, raw, rawLen: raw.length };
    }
  } catch {
    return { body: {}, raw: "", rawLen: 0 };
  }
}

/** ---------------- auth: system OR user ---------------- */
type AuthFail = { ok: false; status: number; error: string };
type AuthSystem = { ok: true; mode: "system"; userId: null };
type AuthUser = { ok: true; mode: "user"; userId: string };
type AuthResult = AuthFail | AuthSystem | AuthUser;

function isAuthFail(a: AuthResult): a is AuthFail {
  return a.ok === false;
}

async function requireSystemOrUser(req: Request): Promise<AuthResult> {
  const provided = req.headers.get("x-ingest-secret") || "";
  const expected = process.env.INGEST_SECRET || "";

  // System mode: ingest secret
  if (expected && provided && provided === expected) {
    return { ok: true, mode: "system", userId: null };
  }

  // User mode: cookie-bound Supabase auth
  const supabaseAuth = getUserSupabase();
  const { data, error } = await supabaseAuth.auth.getUser();
  if (error || !data?.user?.id) return { ok: false, status: 401, error: "Unauthorized" };

  return { ok: true, mode: "user", userId: data.user.id };
}

/** ---------------- handler ---------------- */
export async function POST(req: Request) {
  try {
    const auth = await requireSystemOrUser(req);
    if (isAuthFail(auth)) return json(auth.status, { ok: false, phase: "auth", error: auth.error });

    const { body, raw, rawLen } = await readJson(req);
    const u = new URL(req.url);

    // Accept multiple key names (body OR query params)
    const analysisId = String(
      body?.analysisId ??
        body?.analysis_id ??
        body?.id ??
        u.searchParams.get("analysisId") ??
        u.searchParams.get("analysis_id") ??
        u.searchParams.get("id") ??
        ""
    ).trim();

    const targetDocumentId = String(
      body?.target_document_id ??
        body?.targetDocumentId ??
        body?.document_id ??
        body?.documentId ??
        u.searchParams.get("target_document_id") ??
        u.searchParams.get("document_id") ??
        ""
    ).trim();

    const kind =
      String(body?.kind ?? body?.analysisKind ?? u.searchParams.get("kind") ?? "case_fact_audit").trim() ||
      "case_fact_audit";

    const limit = clampInt(body?.limit ?? u.searchParams.get("limit"), 60, 1, 500);
    const excerptMaxChars = clampInt(
      body?.maxChars ?? body?.excerptMaxChars ?? u.searchParams.get("maxChars"),
      1200,
      200,
      8000
    );
    const maxFindings = clampInt(body?.maxFindings ?? u.searchParams.get("maxFindings"), 25, 1, 300);

    if (!isUuid(analysisId)) {
      return json(400, {
        ok: false,
        phase: "input",
        error: "analysisId (UUID) is required",
        hint: "Send JSON {analysisId} or use ?analysisId=... query param",
        receivedKeys: Object.keys(body || {}),
        receivedAnalysisId: analysisId || null,
        bodyRawLen: rawLen,
        bodyRawSnippet: raw ? raw.slice(0, 500) : "",
      });
    }

    if (!targetDocumentId) {
      return json(400, {
        ok: false,
        phase: "input",
        error: "target_document_id is required",
        hint: "Send JSON {target_document_id} (or document_id) or query params",
        receivedKeys: Object.keys(body || {}),
        bodyRawLen: rawLen,
        bodyRawSnippet: raw ? raw.slice(0, 500) : "",
      });
    }

    // Service role for DB operations
    const supabase = getServiceSupabase();

    // Load analysis row
    const { data: analysis, error: aErr } = await supabase
      .from("analyses")
      .select("*")
      .eq("id", analysisId)
      .maybeSingle();

    if (aErr) return json(500, { ok: false, phase: "load_analysis", error: aErr.message });
    if (!analysis) return json(404, { ok: false, phase: "load_analysis", error: "Analysis not found" });

    // If user-mode, enforce ownership
    if (auth.mode === "user" && analysis.owner_id && analysis.owner_id !== auth.userId) {
      return json(403, { ok: false, phase: "authz", error: "Forbidden" });
    }

    // Mark running + set target_document_id
    const { error: upErr } = await supabase
      .from("analyses")
      .update({
        status: "running",
        target_document_id: targetDocumentId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", analysisId);

    if (upErr) return json(500, { ok: false, phase: "update_analysis", error: upErr.message });

    // Load chunk sample
    const { data: ch, error: chErr } = await supabase
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

    if (!chunks.length) {
      return json(422, {
        ok: false,
        phase: "load_chunks",
        error: "No chunks found for document. Materialize first.",
        document_id: targetDocumentId,
      });
    }

    // Run engine
    const findings = runAuditEngine({
      chunks,
      options: { kind, maxFindings, excerptMaxChars },
    });

    // Insert findings
    if (Array.isArray(findings) && findings.length) {
      const rows = findings.map((f: any) => ({
        analysis_id: analysisId,
        kind: String(f.kind || kind),
        severity: String(f.severity || "info"),
        title: String(f.title || "Finding"),
        claim: String(f.claim || ""),
        evidence: f.evidence ?? null,
        meta: {
          ...(f.meta || {}),
          category: f.category ?? null,
          confidence: f.confidence ?? null,
          target_document_id: targetDocumentId,
        },
      }));

      const { error: fErr } = await supabase.from("analysis_findings").insert(rows);
      if (fErr) return json(500, { ok: false, phase: "insert_findings", error: fErr.message });
    }

    const summary = `Ran ${kind} on ${Math.min(limit, chunks.length)} chunks. findings_inserted=${
      Array.isArray(findings) ? findings.length : 0
    }.`;

    const { error: finErr } = await supabase
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
