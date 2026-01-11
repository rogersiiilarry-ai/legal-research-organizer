// frontend/app/api/audit/run/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Thin orchestrator/dispatcher.
 *
 * Supports:
 *  - mode: "materialize-and-run" (default) -> /api/audit/run/materialize-and-run
 *  - mode: "execute-only"                 -> /api/audit/execute
 *
 * Critical behavior:
 *  - Forwards Cookie header explicitly (Next route handler fetch does NOT auto-forward cookies)
 *  - Forwards x-ingest-secret if present (system mode)
 *  - Resolves internal origin using x-forwarded-* (Vercel) or req.url (dev)
 */

function json(status: number, payload: any) {
  return NextResponse.json(payload, { status });
}

async function readJson(req: Request): Promise<any> {
  const raw = await req.text().catch(() => "");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function safeStr(v: any) {
  return typeof v === "string" ? v.trim() : "";
}

function getOrigin(req: Request) {
  // In prod behind proxy (Vercel), req.url origin can be internal;
  // prefer forwarded headers.
  const proto = safeStr(req.headers.get("x-forwarded-proto")) || "http";
  const host = safeStr(req.headers.get("x-forwarded-host")) || safeStr(req.headers.get("host"));

  if (host) return `${proto}://${host}`;

  // Fallback: parse origin from req.url (works in local dev)
  try {
    return new URL(req.url).origin;
  } catch {
    return "http://localhost:3000";
  }
}

function buildInternalUrl(req: Request, path: string) {
  return `${getOrigin(req)}${path}`;
}

async function forward(req: Request, url: string, body: any) {
  const ingestSecret = safeStr(req.headers.get("x-ingest-secret"));
  const cookie = req.headers.get("cookie") || "";

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // Forward auth cookies (CRITICAL)
  if (cookie) headers["cookie"] = cookie;

  // Forward system secret if present
  if (ingestSecret) headers["x-ingest-secret"] = ingestSecret;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
    cache: "no-store",
  });

  // Safely parse downstream response
  const text = await res.text().catch(() => "");
  let payload: any = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { ok: false, error: "Downstream returned non-JSON response", raw: text.slice(0, 1000) };
  }

  return { status: res.status, payload };
}

export async function POST(req: Request) {
  try {
    const body = await readJson(req);
    const u = new URL(req.url);

    const mode =
      safeStr(body?.mode) ||
      safeStr(u.searchParams.get("mode")) ||
      "materialize-and-run";

    // Normalize fields
    const kind = safeStr(body?.kind) || "case_fact_audit";

    const document_id =
      safeStr(body?.document_id) ||
      safeStr(body?.documentId) ||
      safeStr(u.searchParams.get("document_id")) ||
      safeStr(u.searchParams.get("documentId"));

    if (mode !== "execute-only" && !document_id) {
      return json(400, { ok: false, phase: "input", error: "document_id is required" });
    }

    if (mode === "execute-only") {
      const analysisId =
        safeStr(body?.analysisId) || safeStr(u.searchParams.get("analysisId"));

      if (!analysisId) {
        return json(400, { ok: false, phase: "input", error: "analysisId is required" });
      }

      const url = buildInternalUrl(req, "/api/audit/execute");
      const { status, payload } = await forward(req, url, { analysisId });
      return json(status, payload);
    }

    // Default: materialize-and-run
    const url = buildInternalUrl(req, "/api/audit/run/materialize-and-run");

    const forwardBody = {
      ...body,
      kind,
      document_id,
      // prevent downstream confusion
      documentId: undefined,
    };

    const { status, payload } = await forward(req, url, forwardBody);

    // Light debug info if something fails (helps stop “looping blind”)
    if (status >= 400) {
      return json(status, {
        ...payload,
        debug: {
          forwardedTo: url,
          mode,
          hasCookie: Boolean(req.headers.get("cookie")),
          hasIngestSecret: Boolean(req.headers.get("x-ingest-secret")),
          document_id: document_id || null,
        },
      });
    }

    return json(status, payload);
  } catch (e: any) {
    return json(500, { ok: false, phase: "exception", error: e?.message || String(e) });
  }
}
