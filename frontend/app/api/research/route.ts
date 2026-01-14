// frontend/app/api/research/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* -------------------------------- helpers -------------------------------- */

function json(status: number, payload: any, extraHeaders?: HeadersInit) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "no-store", ...(extraHeaders || {}) },
  });
}

async function readJson(req: Request) {
  const raw = await req.text().catch(() => "");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function originOf(req: Request) {
  // Vercel/Next: prefer forwarded headers
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  if (host) return `${proto}://${host}`;
  return new URL(req.url).origin;
}

function forwardHeaders(req: Request) {
  // Forward session cookies for Supabase auth
  const cookie = req.headers.get("cookie") || "";
  return {
    "content-type": "application/json",
    accept: "application/json",
    ...(cookie ? { cookie } : {}),
  } as Record<string, string>;
}

/* --------------------------------- route --------------------------------- */

/**
 * /api/research is the UI-facing entry point for "Materialize".
 *
 * It MUST:
 *  - call /api/audit/run (the gate that creates analysis + Stripe checkout when unpaid)
 *  - if unpaid: return 402 + checkout_url so the client can redirect to Stripe immediately
 *  - if paid/entitled: return 200 + analysisId
 *
 * It should NOT call /api/audit/execute here (execute is Step 2).
 */
export async function POST(req: Request) {
  try {
    const body = await readJson(req);
    const headers = forwardHeaders(req);
    const origin = originOf(req);

    // Call the gate route that handles:
    // - create analysis
    // - Stripe checkout if unpaid
    // - materialize if entitled
    const runRes = await fetch(`${origin}/api/audit/run`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      cache: "no-store",
    });

    const runJson = await runRes.json().catch(() => ({}));

    // Pass through Stripe paywall response so client can redirect to checkout_url
    if (runRes.status === 402) {
      return json(402, {
        ok: false,
        phase: "stripe",
        error: runJson?.error || "Payment required",
        checkout_url: runJson?.checkout_url || runJson?.url || null,
        analysisId: runJson?.analysisId || runJson?.analysis_id || null,
        raw: runJson,
      });
    }

    // Other errors
    if (!runRes.ok) {
      return json(runRes.status, {
        ok: false,
        where: "/api/audit/run",
        ...runJson,
      });
    }

    // Success: should contain analysisId
    const analysisId =
      runJson?.analysisId ||
      runJson?.analysis_id ||
      runJson?.id ||
      runJson?.runId ||
      runJson?.uuid ||
      null;

    if (!analysisId) {
      return json(500, {
        ok: false,
        error: "audit/run succeeded but no analysisId was returned",
        raw: runJson,
      });
    }

    // Materialize success: return analysisId only (Step 2 is separate)
    return json(200, {
      ok: true,
      analysisId,
      document_id: runJson?.document_id || runJson?.documentId || null,
      note: "Materialize complete. Proceed to Step 2 to execute audit.",
    });
  } catch (e: any) {
    return json(500, { ok: false, error: e?.message || String(e) });
  }
}

export async function GET() {
  return json(200, { ok: true, route: "/api/research", note: "POST to materialize (Stripe-gated) via /api/audit/run" });
}
