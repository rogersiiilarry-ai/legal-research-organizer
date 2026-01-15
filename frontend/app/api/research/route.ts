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
  // Prefer forwarded headers on Vercel
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  if (host) return `${proto}://${host}`;
  return new URL(req.url).origin;
}

function forwardHeaders(req: Request) {
  // Forward:
  //  - cookies (for user auth flows)
  //  - x-ingest-secret (for system auth / PowerShell flows)
  const cookie = req.headers.get("cookie") || "";
  const ingest = req.headers.get("x-ingest-secret") || "";

  return {
    "content-type": "application/json",
    accept: "application/json",
    ...(cookie ? { cookie } : {}),
    ...(ingest ? { "x-ingest-secret": ingest } : {}),
  } as Record<string, string>;
}

/* --------------------------------- route --------------------------------- */

/**
 * /api/research is the UI-facing entry point for "Materialize".
 *
 * IMPORTANT:
 * - Do NOT call /api/audit/run (middleware blocks it)
 * - Call /api/audit/run/materialize-and-run (middleware allows it)
 *
 * Behavior:
 * - If unpaid: return 402 + checkout_url so client can redirect to Stripe immediately
 * - If paid/entitled/system: returns 200 + analysisId
 */
export async function POST(req: Request) {
  try {
    const body = await readJson(req);
    const headers = forwardHeaders(req);
    const origin = originOf(req);

    // ✅ Call the allowed materialize-and-run gate
    const runRes = await fetch(`${origin}/api/audit/run/materialize-and-run`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      cache: "no-store",
    });

    const runJson = await runRes.json().catch(() => ({} as any));

    // ✅ Paywall passthrough: client redirects to Stripe immediately
    if (runRes.status === 402) {
      return json(402, {
        ok: false,
        phase: "stripe",
        error: runJson?.error || "Payment required",
        checkout_url: runJson?.checkout_url || runJson?.url || null,
        analysisId: runJson?.analysisId || runJson?.analysis_id || runJson?.id || null,
        raw: runJson,
      });
    }

    // Other errors
    if (!runRes.ok) {
      return json(runRes.status, {
        ok: false,
        where: "/api/audit/run/materialize-and-run",
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
        error: "materialize-and-run succeeded but no analysisId was returned",
        raw: runJson,
      });
    }

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
  return json(200, {
    ok: true,
    route: "/api/research",
    note: "POST to materialize via /api/audit/run/materialize-and-run (Stripe-gated).",
  });
}
