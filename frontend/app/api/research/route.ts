import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(status: number, payload: any) {
  return NextResponse.json(payload, { status });
}

async function readJson(req: Request) {
  const raw = await req.text().catch(() => "");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function forwardHeaders(req: Request) {
  // Forward session cookies so middleware/auth applies consistently to internal calls
  const cookie = req.headers.get("cookie") || "";
  return {
    "content-type": "application/json",
    ...(cookie ? { cookie } : {}),
  };
}

export async function POST(req: Request) {
  try {
    const body = await readJson(req);
    const headers = forwardHeaders(req);

    // 1) Run canonical audit pipeline (materialize + run)
    const runRes = await fetch(new URL("/api/audit/run/materialize-and-run", req.url), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const runJson = await runRes.json().catch(() => ({}));
    if (!runRes.ok) return json(runRes.status, { ok: false, where: "audit/run/materialize-and-run", ...runJson });

    const analysisId =
      runJson.analysisId ||
      runJson.id ||
      runJson.runId ||
      runJson.uuid ||
      runJson.analysis_id ||
      null;

    if (!analysisId) {
      return json(500, { ok: false, error: "audit run succeeded but no analysisId was returned", runJson });
    }

    // 2) Execute/assemble final audit output
    const execRes = await fetch(new URL("/api/audit/execute", req.url), {
      method: "POST",
      headers,
      body: JSON.stringify({ analysisId, ...body }),
    });

    const execJson = await execRes.json().catch(() => ({}));
    if (!execRes.ok) return json(execRes.status, { ok: false, where: "audit/execute", ...execJson });

    // 3) Return audit plus optional research/education slots
    const markdown =
      execJson.markdown ||
      execJson.reportMarkdown ||
      execJson.educationMarkdown ||
      "";

    return json(200, {
      ok: true,
      analysisId,
      audit: execJson,
      markdown,
      report: execJson.report || execJson.result || null,
      educationalReport: execJson.educationalReport || null,
    });
  } catch (e: any) {
    return json(500, { ok: false, error: e?.message || String(e) });
  }
}

export async function GET() {
  return json(200, { ok: true, route: "/api/research", note: "POST to run audit-wrapped research" });
}
