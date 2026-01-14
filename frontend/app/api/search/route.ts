import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* =========================================================
   AUTH (true dual mode)
   - System: x-ingest-secret === INGEST_SECRET
   - User (cookie): Supabase cookie session
   - User (bearer): Authorization: Bearer <access_token>
========================================================= */

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function json(status: number, payload: any) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function safeText(v: any) {
  return typeof v === "string" ? v : "";
}

function readBearer(req: Request) {
  const h = safeText(req.headers.get("authorization")).trim();
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || "";
}

type AuthResult =
  | { ok: true; mode: "system"; userId: null }
  | { ok: true; mode: "user"; userId: string }
  | { ok: false; status: number; error: string; detail?: any };

async function requireSystemOrUser(req: Request): Promise<AuthResult> {
  // 1) System secret bypass
  const provided = safeText(req.headers.get("x-ingest-secret")).trim();
  const expected = safeText(process.env.INGEST_SECRET).trim();
  if (expected && provided && provided === expected) {
    return { ok: true, mode: "system", userId: null };
  }

  // 2) Bearer token auth (important for API calls without cookies)
  const bearer = readBearer(req);
  if (bearer) {
    try {
      const supabaseUrl = mustEnv("NEXT_PUBLIC_SUPABASE_URL");
      const supabaseAnon = mustEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

      const supabaseJwt = createClient(supabaseUrl, supabaseAnon, {
        auth: { persistSession: false },
      });

      const { data, error } = await supabaseJwt.auth.getUser(bearer);
      if (!error && data?.user?.id) {
        return { ok: true, mode: "user", userId: data.user.id };
      }

      // If bearer is present but invalid, treat as unauthorized
      return { ok: false, status: 401, error: "Unauthorized" };
    } catch (e: any) {
      return { ok: false, status: 401, error: "Unauthorized" };
    }
  }

  // 3) Cookie session auth (browser)
  const cookieStore = cookies();

  const supabase = createServerClient(
    mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
    mustEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        // Route handlers aren’t returning a mutable response here,
        // so set/remove are no-ops (fine for getUser()).
        set() {},
        remove() {},
      },
    }
  );

  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user?.id) return { ok: false, status: 401, error: "Unauthorized" };

  return { ok: true, mode: "user", userId: data.user.id };
}

/* =========================================================
   CourtListener Search API (v4) + hardened parsing (unchanged)
========================================================= */

const BASE = process.env.COURTLISTENER_BASE || "https://www.courtlistener.com/api/rest/v4";

const REGION_COURTS: Record<string, string[]> = {
  mi_state_only: ["mich", "michctapp"],
  mi_federal: ["mied", "miwd", "ca6"],
  mi_state_and_federal: ["mich", "michctapp", "mied", "miwd", "ca6"],

  mi_surrounding: [
    "mied", "miwd", "ca6",
    "ohnd", "ohsd",
    "innd", "insd",
    "ilnd", "ilcd", "ilsd",
    "wied", "wiwd",
    "mnd",
    "ohioctapp",
    "illappct",
  ],
  mi_surrounding_state_first: ["mied", "miwd", "mich", "michctapp", "ohioctapp", "illappct"],
};

const LIMIT_MIN = 1;
const LIMIT_MAX = 50;
const LIMIT_DEFAULT = 10;

const uniq = (arr: any[]) => [...new Set((arr || []).filter(Boolean))];

const clampInt = (n: any, min: number, max: number, d: number) => {
  const x = Number(n);
  return Number.isFinite(x) ? Math.min(Math.max(Math.trunc(x), min), max) : d;
};

const splitCsv = (v: any) =>
  typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];

function safeLimit(n: any) {
  return clampInt(n, LIMIT_MIN, LIMIT_MAX, LIMIT_DEFAULT);
}

function isObject(v: any) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function tryJsonParse(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function tryUnwrapQuotedJson(raw: any) {
  let s = safeText(raw).trim();
  if (!s) return null;

  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith("’") && s.endsWith("’"))) {
    s = s.slice(1, -1).trim();
  }

  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("“") && s.endsWith("”"))) {
    const inner = tryJsonParse(s);
    if (typeof inner === "string") {
      const obj = tryJsonParse(inner);
      if (obj) return obj;
    }
  }

  const obj = tryJsonParse(s);
  if (obj) return obj;

  return null;
}

function tryFormUrlEncoded(raw: any) {
  const s = safeText(raw).trim();
  if (!s || !s.includes("=")) return null;
  try {
    const sp = new URLSearchParams(s);
    const out: any = {};
    for (const [k, v] of sp.entries()) out[k] = v;
    return out;
  } catch {
    return null;
  }
}

function tryLooseObject(raw: any) {
  const s = safeText(raw).trim();
  if (!s.startsWith("{") || !s.endsWith("}")) return null;

  const inner = s.slice(1, -1).trim();
  if (!inner) return null;

  const out: any = {};
  const parts = inner.split(",").map((p) => p.trim()).filter(Boolean);
  for (const p of parts) {
    const idx = p.indexOf(":");
    if (idx === -1) continue;
    const k = p.slice(0, idx).trim().replace(/^"+|"+$/g, "");
    const v = p.slice(idx + 1).trim().replace(/^"+|"+$/g, "");
    if (k) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

async function readBodyBestEffort(req: Request) {
  const contentType = safeText(req.headers.get("content-type")).toLowerCase();

  let raw = "";
  try {
    raw = await req.text();
  } catch {
    raw = "";
  }

  const rawPreview = raw.length > 240 ? raw.slice(0, 240) : raw;

  let parsed: any = tryJsonParse(raw);
  if (!parsed) parsed = tryUnwrapQuotedJson(raw);

  if (!parsed && contentType.includes("application/x-www-form-urlencoded")) {
    parsed = tryFormUrlEncoded(raw);
  }
  if (!parsed) parsed = tryFormUrlEncoded(raw);

  if (!parsed) parsed = tryLooseObject(raw);

  if (!isObject(parsed)) parsed = {};
  return { parsed, rawPreview, contentType };
}

function pickQ(body: any) {
  const q =
    (typeof body.q === "string" && body.q) ||
    (typeof body.query === "string" && body.query) ||
    (typeof body.term === "string" && body.term) ||
    (typeof body.text === "string" && body.text) ||
    "";
  return q.trim();
}

function buildCourtClause(courts: any[]) {
  const list = uniq((courts || []).map((x) => safeText(x).trim().toLowerCase()).filter(Boolean));
  if (!list.length) return "";
  return ` AND (${list.map((c) => `court_id:"${c}"`).join(" OR ")})`;
}

function buildDateClause(filedAfter: any, filedBefore: any) {
  const a = safeText(filedAfter).trim();
  const b = safeText(filedBefore).trim();
  if (a && b) return ` AND dateFiled:[${a} TO ${b}]`;
  if (a) return ` AND dateFiled:[${a} TO *]`;
  if (b) return ` AND dateFiled:[* TO ${b}]`;
  return "";
}

function buildEffectiveQuery({ q, mode, courts, filedAfter, filedBefore }: any) {
  const query = safeText(q).trim();
  if (!query) return "";

  let clause = query;

  if (mode === "topic") {
    const full = `"${query.replace(/"/g, "")}"`;
    clause = `(${full} OR ${query})`;
  }

  clause += buildCourtClause(courts);
  clause += buildDateClause(filedAfter, filedBefore);

  return clause;
}

function applyOrderBy(url: URL, sort: any) {
  const s = safeText(sort).trim();
  if (s === "dateFiled_desc") url.searchParams.set("order_by", "dateFiled desc");
  else if (s === "dateFiled_asc") url.searchParams.set("order_by", "dateFiled asc");
  else if (s === "citeCount_desc") url.searchParams.set("order_by", "citeCount desc");
  else if (s === "citeCount_asc") url.searchParams.set("order_by", "citeCount asc");
}

async function upstreamJson(url: string, token: string) {
  const res = await fetch(url, {
    headers: { Authorization: `Token ${token}`, Accept: "application/json" },
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      ok: false,
      status: res.status,
      error: `CourtListener upstream error (${res.status})`,
      details: text.slice(0, 2000),
    };
  }

  const data = await res.json().catch(() => null);
  return { ok: true, status: 200, data };
}

function pickFirstDownloadUrl(item: any) {
  const opinions = Array.isArray(item?.opinions) ? item.opinions : [];
  for (const op of opinions) {
    const u = typeof op?.download_url === "string" ? op.download_url : "";
    if (u) return u;
  }
  return null;
}

function extractOpinionId(item: any) {
  const opinions = Array.isArray(item?.opinions) ? item.opinions : [];
  const first = opinions[0] || {};
  if (typeof first?.id === "number") return first.id;
  if (typeof first?.opinion_id === "number") return first.opinion_id;
  return null;
}

function normalize(item: any) {
  return {
    id: item?.cluster_id ?? null,
    caseName: safeText(item?.caseName),
    court: safeText(item?.court),
    courtId: safeText(item?.court_id).toLowerCase(),
    courtCitation: safeText(item?.court_citation_string),
    dateFiled: item?.dateFiled ?? null,
    docketNumber: safeText(item?.docketNumber),
    citeCount: typeof item?.citeCount === "number" ? item.citeCount : 0,
    url: item?.absolute_url ? `https://www.courtlistener.com${item.absolute_url}` : "",
    pdf: pickFirstDownloadUrl(item),
    snippet: safeText(item?.opinions?.[0]?.snippet) || safeText(item?.snippet),
    opinionId: extractOpinionId(item),
  };
}

/* =========================================================
   ROUTES
========================================================= */

export async function GET(req: Request) {
  const auth = await requireSystemOrUser(req);
  if (auth.ok === false) return json(auth.status, { ok: false, error: auth.error });

  return json(200, {
    ok: true,
    regions: Object.keys(REGION_COURTS),
    note: "POST expects JSON body with at least { q: string }.",
  });
}

export async function POST(req: Request) {
  const auth = await requireSystemOrUser(req);
  if (auth.ok === false) return json(auth.status, { ok: false, error: auth.error });

  const token = process.env.COURTLISTENER_TOKEN;
  if (!token) return json(500, { ok: false, error: "Missing COURTLISTENER_TOKEN in environment." });

  const { parsed: body, rawPreview, contentType } = await readBodyBestEffort(req);

  const u = new URL(req.url);
  const urlParams: any = {
    q: u.searchParams.get("q") || u.searchParams.get("query") || "",
    mode: u.searchParams.get("mode") || "",
    region: u.searchParams.get("region") || "",
    courts: splitCsv(u.searchParams.get("courts") || ""),
    filedAfter: u.searchParams.get("filedAfter") || "",
    filedBefore: u.searchParams.get("filedBefore") || "",
    sort: u.searchParams.get("sort") || "",
    limit: u.searchParams.get("limit") || "",
  };

  const merged: any = { ...urlParams, ...(isObject(body) ? body : {}) };

  const q = pickQ(merged);
  const mode = merged.mode === "party" || merged.mode === "topic" ? merged.mode : "topic";

  const region =
    typeof merged.region === "string" && merged.region.trim() ? merged.region.trim() : "mi_state_only";

  const sort = typeof merged.sort === "string" && merged.sort.trim() ? merged.sort.trim() : "dateFiled_desc";
  const limit = safeLimit(merged.limit);

  const filedAfter = typeof merged.filedAfter === "string" ? merged.filedAfter.trim() : "";
  const filedBefore = typeof merged.filedBefore === "string" ? merged.filedBefore.trim() : "";

  let courts: any[] = [];
  if (Array.isArray(merged.courts)) courts = merged.courts;
  else if (typeof merged.courts === "string") courts = splitCsv(merged.courts);

  const defaultCourts = (REGION_COURTS as any)[region] || REGION_COURTS.mi_state_only;
  const finalCourts = uniq((courts.length ? courts : defaultCourts).map((x: any) => safeText(x)));

  if (!q) {
    return json(400, {
      ok: false,
      error: "Missing 'q' (query).",
      debugEcho: {
        contentType,
        rawBodyPreview: rawPreview,
        bodyKeys: Object.keys(isObject(body) ? body : {}),
      },
    });
  }

  const effectiveQuery = buildEffectiveQuery({ q, mode, courts: finalCourts, filedAfter, filedBefore });

  const url = new URL(`${BASE.replace(/\/$/, "")}/search/`);
  url.searchParams.set("q", effectiveQuery);
  url.searchParams.set("page_size", String(limit));
  applyOrderBy(url, sort);

  const up = await upstreamJson(url.toString(), token);
  if (!(up as any).ok) return json(502, { ok: false, kind: "search", ...(up as any) });

  const raw = Array.isArray((up as any).data?.results) ? (up as any).data.results : [];
  const results = raw.slice(0, limit).map(normalize);

  return json(200, {
    ok: true,
    kind: "search",
    q,
    mode,
    region,
    courts: finalCourts,
    sort,
    filedAfter: filedAfter || null,
    filedBefore: filedBefore || null,
    limit,
    debug: { effectiveQuery },
    count: Number((up as any).data?.count || results.length),
    results,
  });
}
