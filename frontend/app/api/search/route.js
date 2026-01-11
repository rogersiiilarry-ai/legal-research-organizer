// frontend/app/api/search/route.js
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* =========================================================
   CourtListener Search API (v4) + Query-Driven Relevance (JS)
   Robust request parsing (curl.exe + PowerShell safe)
========================================================= */

const BASE =
  process.env.COURTLISTENER_BASE || "https://www.courtlistener.com/api/rest/v4";

/**
 * Regions:
 * - mi_state_only: Michigan Supreme Court + Court of Appeals
 * - mi_federal: MI federal district courts + Sixth Circuit
 * - mi_state_and_federal: combined MI state + MI federal + CA6
 * - mi_surrounding: MI + surrounding fed/state buckets
 * - mi_surrounding_state_first: MI state bucket first
 */
const REGION_COURTS = {
  mi_state_only: ["mich", "michctapp"],
  mi_federal: ["mied", "miwd", "ca6"],
  mi_state_and_federal: ["mich", "michctapp", "mied", "miwd", "ca6"],

  mi_surrounding: [
    "mied",
    "miwd",
    "ca6",
    "ohnd",
    "ohsd",
    "innd",
    "insd",
    "ilnd",
    "ilcd",
    "ilsd",
    "wied",
    "wiwd",
    "mnd",
    "ohioctapp",
    "illappct",
  ],
  mi_surrounding_state_first: [
    "mied",
    "miwd",
    "mich",
    "michctapp",
    "ohioctapp",
    "illappct",
  ],
};

// Response caps
const LIMIT_MIN = 1;
const LIMIT_MAX = 50;
const LIMIT_DEFAULT = 10;

// Enrichment caps
const ENRICH_LIMIT = 4;
const OPINION_SCAN_MAX_CHARS = 250_000;

/* =========================================================
   UTILS
========================================================= */

const safeText = (v) => (typeof v === "string" ? v : "");
const uniq = (arr) => [...new Set((arr || []).filter(Boolean))];

const clampInt = (n, min, max, d) => {
  const x = Number(n);
  return Number.isFinite(x) ? Math.min(Math.max(Math.trunc(x), min), max) : d;
};

const splitCsv = (v) =>
  typeof v === "string"
    ? v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

function toBool(v) {
  if (v === true || v === 1) return true;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "true" || s === "1" || s === "yes";
  }
  return false;
}

function safeLimit(n) {
  return clampInt(n, LIMIT_MIN, LIMIT_MAX, LIMIT_DEFAULT);
}

function isObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/* =========================================================
   ROBUST BODY PARSING (FIXES YOUR CURL/PS ISSUES)
========================================================= */

function tryJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function tryUnwrapQuotedJson(raw) {
  // Handles cases where body arrives as a JSON string containing JSON
  // e.g. "\"{\\\"q\\\":\\\"x\\\"}\"" or "'{...}'"
  let s = safeText(raw).trim();
  if (!s) return null;

  // Strip wrapping single quotes (PowerShell often preserves them literally)
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith("’") && s.endsWith("’"))) {
    s = s.slice(1, -1).trim();
  }

  // If it's a quoted JSON string, parse once to get inner JSON text
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("“") && s.endsWith("”"))) {
    const inner = tryJsonParse(s);
    if (typeof inner === "string") {
      const obj = tryJsonParse(inner);
      if (obj) return obj;
    }
  }

  // If it now looks like JSON, parse normally
  const obj = tryJsonParse(s);
  if (obj) return obj;

  return null;
}

function tryFormUrlEncoded(raw) {
  const s = safeText(raw).trim();
  if (!s || !s.includes("=")) return null;
  try {
    const sp = new URLSearchParams(s);
    const out = {};
    for (const [k, v] of sp.entries()) out[k] = v;
    return out;
  } catch {
    return null;
  }
}

function tryLooseObject(raw) {
  // Handles your observed pattern: {q:michigan smoke,region:mi_state_and_federal}
  // This is NOT JSON, but we can salvage it.
  const s = safeText(raw).trim();
  if (!s.startsWith("{") || !s.endsWith("}")) return null;

  // Remove braces, split by commas, split each by first colon
  const inner = s.slice(1, -1).trim();
  if (!inner) return null;

  const out = {};
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

async function readBodyBestEffort(req) {
  const contentType = safeText(req.headers.get("content-type")).toLowerCase();

  // Read raw body ONCE
  let raw = "";
  try {
    raw = await req.text();
  } catch {
    raw = "";
  }

  const rawPreview = raw.length > 240 ? raw.slice(0, 240) : raw;

  // 1) JSON parse (normal)
  let parsed = tryJsonParse(raw);

  // 2) Unwrap quoted JSON / strip wrapping quotes
  if (!parsed) parsed = tryUnwrapQuotedJson(raw);

  // 3) x-www-form-urlencoded
  if (!parsed && contentType.includes("application/x-www-form-urlencoded")) {
    parsed = tryFormUrlEncoded(raw);
  }
  // Even if content-type claims JSON, try salvage if it looks form-like
  if (!parsed) parsed = tryFormUrlEncoded(raw);

  // 4) salvage loose object-ish body like {q:abc,region:def}
  if (!parsed) parsed = tryLooseObject(raw);

  // Ensure object
  if (!isObject(parsed)) parsed = {};

  return { parsed, raw, rawPreview, contentType };
}

function pickQ(body) {
  // accept several names
  const q =
    (typeof body.q === "string" && body.q) ||
    (typeof body.query === "string" && body.query) ||
    (typeof body.term === "string" && body.term) ||
    (typeof body.text === "string" && body.text) ||
    "";
  return q.trim();
}

/* =========================================================
   UPSTREAM QUERY BUILDING
========================================================= */

function buildCourtClause(courts) {
  const list = uniq((courts || []).map((x) => safeText(x).trim().toLowerCase()).filter(Boolean));
  if (!list.length) return "";
  return ` AND (${list.map((c) => `court_id:"${c}"`).join(" OR ")})`;
}

function buildDateClause(filedAfter, filedBefore) {
  const a = safeText(filedAfter).trim();
  const b = safeText(filedBefore).trim();
  if (a && b) return ` AND dateFiled:[${a} TO ${b}]`;
  if (a) return ` AND dateFiled:[${a} TO *]`;
  if (b) return ` AND dateFiled:[* TO ${b}]`;
  return "";
}

function buildEffectiveQuery({ q, mode, courts, filedAfter, filedBefore }) {
  const query = safeText(q).trim();
  if (!query) return "";

  let clause = query;

  // "topic" mode can expand lightly; keep it safe
  if (mode === "topic") {
    const full = `"${query.replace(/"/g, "")}"`;
    clause = `(${full} OR ${query})`;
  }

  clause += buildCourtClause(courts);
  clause += buildDateClause(filedAfter, filedBefore);

  return clause;
}

function applyOrderBy(url, sort) {
  const s = safeText(sort).trim();
  if (s === "dateFiled_desc") url.searchParams.set("order_by", "dateFiled desc");
  else if (s === "dateFiled_asc") url.searchParams.set("order_by", "dateFiled asc");
  else if (s === "citeCount_desc") url.searchParams.set("order_by", "citeCount desc");
  else if (s === "citeCount_asc") url.searchParams.set("order_by", "citeCount asc");
}

/* =========================================================
   UPSTREAM FETCH
========================================================= */

async function upstreamJson(url, token) {
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

/* =========================================================
   NORMALIZATION (LIGHT)
========================================================= */

function pickFirstDownloadUrl(item) {
  const opinions = Array.isArray(item?.opinions) ? item.opinions : [];
  for (const op of opinions) {
    const u = typeof op?.download_url === "string" ? op.download_url : "";
    if (u) return u;
  }
  return null;
}

function extractOpinionId(item) {
  const opinions = Array.isArray(item?.opinions) ? item.opinions : [];
  const first = opinions[0] || {};
  if (typeof first?.id === "number") return first.id;
  if (typeof first?.opinion_id === "number") return first.opinion_id;
  return null;
}

function normalize(item) {
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

export async function GET(req) {
  return NextResponse.json({
    ok: true,
    env: {
      tokenPresent: !!process.env.COURTLISTENER_TOKEN,
      base: BASE,
    },
    regions: Object.keys(REGION_COURTS),
    regionDefaults: REGION_COURTS,
    note:
      "POST expects JSON body with at least { q: string }. This route has hardened parsing for curl.exe + PowerShell.",
  });
}

export async function POST(req) {
  const token = process.env.COURTLISTENER_TOKEN;
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "Missing COURTLISTENER_TOKEN in environment." },
      { status: 500 }
    );
  }

  // Parse body robustly
  const { parsed: body, rawPreview, contentType } = await readBodyBestEffort(req);

  // Also accept URL params if present
  const u = new URL(req.url);
  const urlParams = {
    q: u.searchParams.get("q") || u.searchParams.get("query") || "",
    mode: u.searchParams.get("mode") || "",
    region: u.searchParams.get("region") || "",
    level: u.searchParams.get("level") || "",
    courts: splitCsv(u.searchParams.get("courts") || ""),
    filedAfter: u.searchParams.get("filedAfter") || "",
    filedBefore: u.searchParams.get("filedBefore") || "",
    sort: u.searchParams.get("sort") || "",
    limit: u.searchParams.get("limit") || "",
    strict: u.searchParams.get("strict") || "",
  };

  // Merge url first, then body overrides
  const merged = { ...urlParams, ...(isObject(body) ? body : {}) };

  const q = pickQ(merged);
  const mode = merged.mode === "party" || merged.mode === "topic" ? merged.mode : "topic";

  const region =
    typeof merged.region === "string" && merged.region.trim()
      ? merged.region.trim()
      : "mi_state_only";

  const sort =
    typeof merged.sort === "string" && merged.sort.trim()
      ? merged.sort.trim()
      : "dateFiled_desc";

  const limit = safeLimit(merged.limit);
  const filedAfter = typeof merged.filedAfter === "string" ? merged.filedAfter.trim() : "";
  const filedBefore = typeof merged.filedBefore === "string" ? merged.filedBefore.trim() : "";

  // Courts default by region
  let courts = [];
  if (Array.isArray(merged.courts)) courts = merged.courts;
  else if (typeof merged.courts === "string") courts = splitCsv(merged.courts);

  const defaultCourts = REGION_COURTS[region] || REGION_COURTS.mi_state_only;
  const finalCourts = uniq((courts.length ? courts : defaultCourts).map((x) => safeText(x)));

  if (!q) {
    return NextResponse.json(
      {
        ok: false,
        error: "Missing 'q' (query).",
        debugEcho: {
          contentType,
          rawBodyPreview: rawPreview,
          bodyKeys: Object.keys(isObject(body) ? body : {}),
          bodyQ: isObject(body) ? (body.q ?? body.query ?? body.term ?? body.text ?? null) : null,
          urlParams,
        },
      },
      { status: 400 }
    );
  }

  const effectiveQuery = buildEffectiveQuery({
    q,
    mode,
    courts: finalCourts,
    filedAfter,
    filedBefore,
  });

  const url = new URL(`${BASE.replace(/\/$/, "")}/search/`);
  url.searchParams.set("q", effectiveQuery);
  url.searchParams.set("page_size", String(limit));
  applyOrderBy(url, sort);

  const up = await upstreamJson(url.toString(), token);
  if (!up.ok) {
    return NextResponse.json({ ok: false, kind: "search", ...up }, { status: 502 });
  }

  const raw = Array.isArray(up.data?.results) ? up.data.results : [];
  const results = raw.slice(0, limit).map(normalize);

  return NextResponse.json({
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
    count: Number(up.data?.count || results.length),
    results,
  });
}
