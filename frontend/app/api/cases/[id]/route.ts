// frontend/app/api/cases/[id]/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const BASE = "https://www.courtlistener.com/api/rest/v4";

function json(status: number, payload: any) {
  return NextResponse.json(payload, { status });
}

function clampStr(v: any, max = 200) {
  if (typeof v !== "string") return "";
  const s = v.trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max) : s;
}

function toArrayOfStrings(v: any, max = 25): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    const s = clampStr(x, 80);
    if (s) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Route signature for dynamic segment: /api/cases/[id]
 * Next.js app router provides params as second arg
 */
export async function POST(req: Request, ctx: { params: { id: string } }) {
  try {
    const id = clampStr(ctx?.params?.id, 120);

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const caseNumber = clampStr(body?.caseNumber ?? body?.case_number ?? "", 120);
    const courts = toArrayOfStrings(body?.courts ?? body?.courtIds ?? body?.court_ids ?? [], 50);

    if (!id) return json(400, { ok: false, error: "Missing route param: id" });
    if (!caseNumber) return json(400, { ok: false, error: "caseNumber is required" });

    const apiKey = process.env.COURTLISTENER_API_KEY || process.env.COURT_LISTENER_API_KEY || "";
    if (!apiKey) {
      return json(500, { ok: false, error: "Missing CourtListener API key (COURTLISTENER_API_KEY)" });
    }

    // Example: search endpoint — adjust query to whatever you intended originally.
    // This is intentionally conservative and returns the raw results.
    const q = new URLSearchParams();
    q.set("q", caseNumber);
    // If you intended court filters, CourtListener commonly uses `court=` or `court_id=` depending on endpoint.
    // We include them as repeated `court=` params.
    for (const c of courts) q.append("court", c);

    const url = `${BASE}/search/?${q.toString()}`;

    const r = await fetch(url, {
      headers: {
        Authorization: `Token ${apiKey}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });

    const text = await r.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }

    if (!r.ok) {
      return json(r.status, {
        ok: false,
        error: "CourtListener request failed",
        status: r.status,
        response: data,
      });
    }

    // Return results and the route id you called with
    return json(200, {
      ok: true,
      id,
      caseNumber,
      courts,
      data,
    });
  } catch (e: any) {
    return json(500, { ok: false, error: e?.message || String(e) });
  }
}
