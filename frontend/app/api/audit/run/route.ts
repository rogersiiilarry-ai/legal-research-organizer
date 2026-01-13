// frontend/app/api/audit/run/route.ts
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
  const proto = safeStr(req.headers.get("x-forwarded-proto")) || "https";
  const host = safeStr(req.headers.get("x-forwarded-host")) || safeStr(req.headers.get("host"));
  if (host) return `${proto}://${host}`;

  try {
    return new URL(req.url).origin;
  } catch {
    return "http://localhost:3000";
  }
}

function buildInternalUrl(req: Request, path: string) {
  return `${getOrigin(req)}${path}`;
}

function getAllSetCookies(res: Response): string[] {
  // Node/undici supports getSetCookie() in some runtimes; Next may polyfill.
  const anyHeaders: any = res.headers as any;

  if (typeof anyHeaders.getSetCookie === "function") {
    const arr = anyHeaders.getSetCookie();
    if (Array.isArray(arr) && arr.length) return arr;
  }

  // Fallback: single header (may be comma-joined; imperfect but better than nothing)
  const sc = res.headers.get("set-cookie");
  return sc ? [sc] : [];
}

function applySetCookie(out: NextResponse, setCookies: string[]) {
  for (const v of setCookies) out.headers.append("set-cookie", v);
  return out;
}

/* ----------------------------- forward plumbing ---------------------------- */

type ForwardResult =
  | { kind: "redirect"; status: number; location: string; setCookies: string[] }
  | { kind: "json"; status: number; payload: any; setCookies: string[] };

async function forward(req: Request, url: string, body: any): Promise<ForwardResult> {
  const ingestSecret = safeStr(req.headers.get("x-ingest-secret"));
  const cookie = req.headers.get("cookie") || "";

  // IMPORTANT:
  // - For XHR/fetch, prefer JSON accept. Stripe redirects are handled by GET /audit/run (browser nav).
  // - If you want redirects on POST too, set Accept to include text/html.
  const accept = req.method === "GET"
    ? (req.headers.get("accept") || "text/html,application/json;q=0.9,*/*;q=0.8")
    : "application/json";

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept,
  };

  if (cookie) headers["cookie"] = cookie;
  if (ingestSecret) headers["x-ingest-secret"] = ingestSecret;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
    cache: "no-store",
    redirect: "manual",
  });

  const setCookies = getAllSetCookies(res);

  // Redirect case (Stripe checkout redirect, etc.)
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location") || "";
    if (location) return { kind: "redirect", status: res.status, location, setCookies };
  }

  const text = await res.text().catch(() => "");
  let payload: any = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {
      ok: false,
      error: "Downstream returned non-JSON response",
      raw: text.slice(0, 1000),
    };
  }

  return { kind: "json", status: res.status, payload, setCookies };
}

/* --------------------------------- handler -------------------------------- */

async function handle(req: Request, body: any) {
  const u = new URL(req.url);

  const mode = safeStr(body?.mode) || safeStr(u.searchParams.get("mode")) || "materialize-and-run";
  const kind = safeStr(body?.kind) || safeStr(u.searchParams.get("kind")) || "case_fact_audit";

  const document_id =
    safeStr(body?.document_id) ||
    safeStr(body?.documentId) ||
    safeStr(u.searchParams.get("document_id")) ||
    safeStr(u.searchParams.get("documentId"));

  if (mode !== "execute-only" && !document_id) {
    return json(400, { ok: false, phase: "input", error: "document_id is required" });
  }

  // execute-only → forward to /api/audit/execute
  if (mode === "execute-only") {
    const analysisId = safeStr(body?.analysisId) || safeStr(u.searchParams.get("analysisId"));
    if (!analysisId) return json(400, { ok: false, phase: "input", error: "analysisId is required" });

    const url = buildInternalUrl(req, "/api/audit/execute");
    const r = await forward(req, url, { analysisId });

    if (r.kind === "redirect") {
      const out = NextResponse.redirect(r.location, r.status as any);
      return applySetCookie(out, r.setCookies);
    }

    const out = json(r.status, r.payload);
    return applySetCookie(out, r.setCookies);
  }

  // default → forward to materialize-and-run
  const url = buildInternalUrl(req, "/api/audit/run/materialize-and-run");

  const forwardBody = {
    ...body,
    kind,
    document_id,
    documentId: undefined,
  };

  const r = await forward(req, url, forwardBody);

  if (r.kind === "redirect") {
    const out = NextResponse.redirect(r.location, r.status as any);
    return applySetCookie(out, r.setCookies);
  }

  if (r.status >= 400) {
    const out = json(r.status, {
      ...r.payload,
      debug: {
        forwardedTo: url,
        mode,
        hasCookie: Boolean(req.headers.get("cookie")),
        hasIngestSecret: Boolean(req.headers.get("x-ingest-secret")),
        document_id: document_id || null,
      },
    });
    return applySetCookie(out, r.setCookies);
  }

  const out = json(r.status, r.payload);
  return applySetCookie(out, r.setCookies);
}

export async function POST(req: Request) {
  const body = await readJson(req);
  return handle(req, body);
}

// Browser navigation support (Stripe redirect works reliably)
export async function GET(req: Request) {
  return handle(req, {}); // params come from querystring
}