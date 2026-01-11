// frontend/app/api/ingest/circuit/wayne/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";

function json(status: number, payload: any) {
  return NextResponse.json(payload, { status });
}

function clampStr(v: any, max = 160) {
  if (typeof v !== "string") return "";
  const s = v.trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max) : s;
}

export async function POST(req: Request) {
  try {
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const caseNumber = clampStr(body?.caseNumber ?? body?.case_number ?? "", 120);
    if (!caseNumber) {
      return json(400, { ok: false, error: "caseNumber is required" });
    }

    // If you use a secret for ingest endpoints, enforce it here.
    // Keep it consistent with your other ingest routes.
    const expected = process.env.INGEST_SECRET || "";
    if (expected) {
      const provided = req.headers.get("x-ingest-secret") || "";
      if (!provided || provided !== expected) {
        return json(401, { ok: false, error: "Unauthorized" });
      }
    }

    // TODO: Replace this stub with your actual Wayne Circuit ingestion logic.
    // For now, return a stable response so build + deploy can proceed.
    return json(200, {
      ok: true,
      source: "circuit_wayne",
      caseNumber,
      message: "Route is wired. Add Wayne Circuit ingestion implementation next.",
    });
  } catch (e: any) {
    return json(500, { ok: false, error: e?.message || String(e) });
  }
}
