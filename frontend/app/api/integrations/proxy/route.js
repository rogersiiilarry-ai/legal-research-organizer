function parseAllowlist() {
  const raw = process.env.INTEGRATION_PROXY_ALLOWLIST || "";
  return raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function hostFromUrl(u) {
  try { return new URL(u).host; } catch { return ""; }
}

export async function POST(req) {
  const body = await req.json().catch(() => null);
  if (!body?.url) return new Response(JSON.stringify({ ok: false, error: "Missing url" }), { status: 400 });

  const allow = parseAllowlist();
  const host = hostFromUrl(body.url);
  if (allow.length > 0 && !allow.includes(host)) {
    return new Response(JSON.stringify({ ok: false, error: "Host not allowed", host, allow }), { status: 403 });
  }

  const method = (body.method || "GET").toUpperCase();
  const headers = body.headers || {};
  const res = await fetch(body.url, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body.body ?? {}),
  });

  const text = await res.text();
  return new Response(
    JSON.stringify({ ok: res.ok, status: res.status, headers: Object.fromEntries(res.headers.entries()), body: text }),
    { headers: { "Content-Type": "application/json" }, status: res.ok ? 200 : 400 }
  );
}