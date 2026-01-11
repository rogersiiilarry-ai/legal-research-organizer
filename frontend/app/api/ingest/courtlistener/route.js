import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE =
  process.env.COURTLISTENER_BASE || "https://www.courtlistener.com/api/rest/v4";

/**
 * Region defaults.
 * Key point: "mi_surrounding_state_first" intentionally excludes CA6 so
 * “dateFiled_desc” doesn’t get dominated by appellate results.
 */
const REGION_COURTS = {
  // Best default for “Michigan + surrounding” without being flooded by CA6
  mi_surrounding_state_first: [
    // MI federal trial courts
    "mied",
    "miwd",

    // MI state (if CourtListener has them in your results)
    "mich",
    "michctapp",

    // Nearby state appellate (confirmed)
    "ohioctapp",
    "illappct",
  ],

  // Everything (includes CA6)
  mi_surrounding_all: [
    "mied",
    "miwd",
    "ca6",
    "mich",
    "michctapp",
    "ohioctapp",
    "illappct",
  ],

  // Your original expanded list (kept)
  mi_surrounding: [
    "mied",
    "miwd",
    "ca6",
    "ohioctapp",
    "illappct",
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
  ],
};

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.min(Math.max(Math.trunc(x), min), max);
}

function safeString(v) {
  return typeof v === "string" ? v : "";
}

function trimOrEmpty(v) {
  return safeString(v).trim();
}

/**
 * mode:
 *  - "party": use q as-is (often returns party-name Miranda cases)
 *  - "topic": boosts “Miranda rights / warnings” relevance
 */
function buildTopicQuery(q) {
  const cleaned = (q || "").trim();
  if (!cleaned || cleaned.toLowerCase() === "miranda") {
    return `("Miranda v. Arizona" OR "Miranda warning" OR "Miranda warnings" OR "Miranda rights" OR miranda)`;
  }
  return `(${cleaned}) AND ("Miranda v. Arizona" OR "Miranda warning" OR "Miranda rights" OR custodial OR interrogation)`;
}

function buildCourtFilter(courts) {
  if (!Array.isArray(courts) || !courts.length) return "";
  const ors = courts
    .map((c) => String(c || "").trim())
    .filter(Boolean)
    .map((c) => `court_id:"${c.replace(/"/g, "")}"`)
    .join(" OR ");
  return ors ? `(${ors})` : "";
}

function buildDateFilter(filedAfter, filedBefore) {
  const a = (filedAfter || "").trim();
  const b = (filedBefore || "").trim();
  if (a && b) return `dateFiled:[${a} TO ${b}]`;
  if (a) return `dateFiled:[${a} TO *]`;
  if (b) return `dateFiled:[* TO ${b}]`;
  return "";
}

/**
 * Case number / docket:
 * CourtListener’s search fields can vary by index; safest is to include BOTH:
 * - a best-effort field filter docketNumber:"X"
 * - and a plain text "X"
 */
function buildDocketFilter(docket) {
  const d = (docket || "").trim();
  if (!d) return "";
  const safe = d.replace(/"/g, "");
  return `(docketNumber:"${safe}" OR "${safe}")`;
}

function buildEffectiveQuery({ q, mode, courts, filedAfter, filedBefore, docket }) {
  let effective = (q || "").trim() || "miranda";

  if (mode === "topic") {
    effective = buildTopicQuery(effective);
  }

  const parts = [effective];

  const courtFilter = buildCourtFilter(courts);
  if (courtFilter) parts.push(courtFilter);

  const dateFilter = buildDateFilter(filedAfter, filedBefore);
  if (dateFilter) parts.push(dateFilter);

  const docketFilter = buildDocketFilter(docket);
  if (docketFilter) parts.push(docketFilter);

  // Join with AND so each clause narrows the search
  return parts.join(" AND ");
}

function applyOrderBy(url, sort) {
  if (sort === "dateFiled_desc") url.searchParams.set("order_by", "dateFiled desc");
  else if (sort === "dateFiled_asc") url.searchParams.set("order_by", "dateFiled asc");
  else if (sort === "citeCount_desc") url.searchParams.set("order_by", "citeCount desc");
  else if (sort === "citeCount_asc") url.searchParams.set("order_by", "citeCount asc");
  // relevance/default: omit order_by
}

function pickFirstDownloadUrl(item) {
  const opinions = Array.isArray(item?.opinions) ? item.opinions : [];
  for (const op of opinions) {
    const url = typeof op?.download_url === "string" ? op.download_url : "";
    if (url) return url;
  }
  return null;
}

function normalizeResult(item) {
  const citations = Array.isArray(item?.citation) ? item.citation.filter(Boolean) : [];

  return {
    id: item?.cluster_id ?? item?.id ?? null,
    caseName: item?.caseName ?? "",
    court: item?.court ?? "",
    courtId: item?.court_id ?? "",
    courtCitation: item?.court_citation_string ?? "",
    dateFiled: item?.dateFiled ?? null,
    dateArgued: item?.dateArgued ?? null,
    docketNumber: item?.docketNumber ?? "",
    citeCount: typeof item?.citeCount === "number" ? item.citeCount : 0,
    citations,
    absoluteUrl: item?.absolute_url ?? "",
    url: item?.absolute_url ? `https://www.courtlistener.com${item.absolute_url}` : "",
    pdf: pickFirstDownloadUrl(item),
    snippet:
      typeof item?.opinions?.[0]?.snippet === "string" ? item.opinions[0].snippet : "",
    source: item?.source ?? "",
    status: item?.status ?? "",
  };
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    usage: `POST {"q":"miranda","limit":10,"sort":"dateFiled_desc","mode":"topic","region":"mi_surrounding_state_first","filedAfter":"1990-01-01","docket":"25-1492","courts":["mied","miwd"]}`,
    env: {
      tokenPresent: !!process.env.COURTLISTENER_TOKEN,
      base: BASE,
    },
    regions: Object.keys(REGION_COURTS),
    regionDefaults: REGION_COURTS,
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

  let body = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const q = trimOrEmpty(body.q) || "miranda";
  const limit = clampInt(body.limit, 1, 50, 10);
  const sort = trimOrEmpty(body.sort) || "dateFiled_desc";

  const mode = body.mode === "topic" || body.mode === "party" ? body.mode : "party";
  const region = trimOrEmpty(body.region);

  const filedAfter = trimOrEmpty(body.filedAfter);
  const filedBefore = trimOrEmpty(body.filedBefore);

  const docket =
    trimOrEmpty(body.docket) ||
    trimOrEmpty(body.docketNumber) ||
    trimOrEmpty(body.caseNumber);

  // Courts: explicit array takes precedence; otherwise region defaults; otherwise empty
  const defaultCourts = region && REGION_COURTS[region] ? REGION_COURTS[region] : [];
  const courts =
    Array.isArray(body.courts) && body.courts.length ? body.courts : defaultCourts;

  const effectiveQuery = buildEffectiveQuery({
    q,
    mode,
    courts,
    filedAfter,
    filedBefore,
    docket,
  });

  const url = new URL(`${BASE.replace(/\/$/, "")}/search/`);
  url.searchParams.set("q", effectiveQuery);
  url.searchParams.set("page_size", String(limit));
  applyOrderBy(url, sort);

  const upstream = await fetch(url.toString(), {
    headers: {
      Authorization: `Token ${token}`,
      Accept: "application/json",
    },
    cache: "no-store",
  });

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    return NextResponse.json(
      {
        ok: false,
        error: `CourtListener upstream error (${upstream.status})`,
        details: text.slice(0, 2000),
      },
      { status: 502 }
    );
  }

  const data = await upstream.json();
  const results = Array.isArray(data?.results) ? data.results : [];
  const normalized = results.map(normalizeResult).slice(0, limit);

  return NextResponse.json({
    ok: true,
    q,
    mode,
    region: region || null,
    courts,
    sort,
    filedAfter: filedAfter || null,
    filedBefore: filedBefore || null,
    docket: docket || null,
    effectiveQuery,
    count: typeof data?.count === "number" ? data.count : normalized.length,
    results: normalized,
  });
}
