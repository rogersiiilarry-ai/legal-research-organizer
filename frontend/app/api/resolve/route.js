import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE =
  process.env.COURTLISTENER_BASE || "https://www.courtlistener.com/api/rest/v4";

async function upstreamJson(url, token) {
  const res = await fetch(url, {
    headers: { Authorization: `Token ${token}`, Accept: "application/json" },
    cache: "no-store",
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    return { ok: false, status: res.status, error: "Upstream error", details: text.slice(0, 2000) };
  }
  try {
    return { ok: true, status: 200, data: JSON.parse(text) };
  } catch {
    return { ok: false, status: 502, error: "Bad upstream JSON" };
  }
}

function safeText(v) {
  return typeof v === "string" ? v : "";
}

export async function POST(req) {
  const token = process.env.COURTLISTENER_TOKEN;
  if (!token) {
    return NextResponse.json({ ok: false, error: "Missing COURTLISTENER_TOKEN" }, { status: 500 });
  }

  let body = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const caseNumber = safeText(body.caseNumber).trim();
  const courts = Array.isArray(body.courts) ? body.courts : [];
  const limit = Number.isFinite(Number(body.limit)) ? Math.max(1, Math.min(50, Number(body.limit))) : 10;

  if (!caseNumber) {
    return NextResponse.json({ ok: false, error: "Missing caseNumber" }, { status: 400 });
  }

  // 1) Docket lookup
  const docketUrl = new URL(`${BASE.replace(/\/$/, "")}/dockets/`);
  docketUrl.searchParams.set("docket_number", caseNumber);
  docketUrl.searchParams.set("page_size", String(limit));
  for (const c of courts) docketUrl.searchParams.append("court", String(c));

  const dUp = await upstreamJson(docketUrl.toString(), token);
  if (!dUp.ok) return NextResponse.json({ ok: false, kind: "docket_lookup", ...dUp }, { status: 502 });

  const dockets = Array.isArray(dUp.data?.results) ? dUp.data.results : [];
  const first = dockets[0] || null;

  // 2) RECAP documents (if any) for the docket id
  // NOTE: the exact filter param can vary; keep it defensive.
  let recapDocs = [];
  if (first?.id) {
    const recapUrl = new URL(`${BASE.replace(/\/$/, "")}/recap-documents/`);
    recapUrl.searchParams.set("page_size", String(limit));
    recapUrl.searchParams.set("docket", String(first.id)); // common pattern

    const rUp = await upstreamJson(recapUrl.toString(), token);
    if (rUp.ok) {
      recapDocs = Array.isArray(rUp.data?.results) ? rUp.data.results : [];
    }
  }

  return NextResponse.json({
    ok: true,
    kind: "resolve",
    caseNumber,
    docket: first
      ? {
          id: first.id,
          caseName: first.case_name,
          courtId: first.court_id,
          docketNumber: first.docket_number,
          dateFiled: first.date_filed,
          url: first.absolute_url ? `https://www.courtlistener.com${first.absolute_url}` : "",
        }
      : null,
    recap: recapDocs.map((d) => ({
      id: d.id,
      description: d.description,
      documentNumber: d.document_number,
      attachmentNumber: d.attachment_number,
      dateFiled: d.date_filed,
      url: d.absolute_url ? `https://www.courtlistener.com${d.absolute_url}` : "",
      downloadUrl: d.filepath_local || d.filepath_ia || d.filepath_s3 || null,
      source: "courtlistener_recap",
    })),
    provenance: {
      docketSource: "courtlistener_dockets",
      recapSource: "courtlistener_recap_documents",
      fetchedAt: new Date().toISOString(),
    },
  });
}
