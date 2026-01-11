import { supabaseServer } from '../../../../lib/supabaseServer';

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req) {
  const body = await req.json().catch(() => ({}));
  const collection = body?.collection || "CREC"; // example
  const query = body?.query || "Supreme Court";
  const pageSize = Math.min(Number(body?.pageSize || 10), 50);

  const apiKey = process.env.GOVINFO_API_KEY;
  if (!apiKey) return Response.json({ ok: false, error: "Missing GOVINFO_API_KEY" }, { status: 500 });

  // govinfo search endpoint
  const url = `https://api.govinfo.gov/search?api_key=${encodeURIComponent(apiKey)}`;

  const payload = {
    query: query,
    pageSize,
    offsetMark: body?.offsetMark || "*",
    collections: [collection],
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    return Response.json({ ok: false, status: res.status, error: t }, { status: 500 });
  }

  const data = await res.json();

  // Store as â€œdocumentsâ€ (you can later map into cases/citations if needed)
  const rows = (data?.results || []).map((r) => ({
    external_source: "govinfo",
    external_id: r?.packageId || r?.granuleId || r?.docId || crypto.randomUUID(),
    title: r?.title || null,
    collection: r?.collectionCode || collection,
    date_issued: r?.dateIssued || null,
    raw: r,
  }));

  const supabase = supabaseServer();
  const { error } = await supabase.from("documents").upsert(rows, {
    onConflict: "external_source,external_id",
  });

  if (error) return Response.json({ ok: false, error }, { status: 500 });

  return Response.json({
    ok: true,
    ingested: rows.length,
    offsetMark: data?.offsetMark || null,
  });
}

