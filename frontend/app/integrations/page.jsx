export default function Integrations() {
  return (
    <main style={{ minHeight: "calc(100vh - 3.2rem)", padding: "1.6rem 1.4rem", display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="card" style={{ maxWidth: 980 }}>
        <h1 style={{ marginTop: 0 }}>Integrations</h1>
        <p className="muted" style={{ marginTop: 6 }}>
          This app includes safe plug surfaces so you can wire external APIs without rewriting core structure.
        </p>
      </div>

      <div className="card" style={{ maxWidth: 980 }}>
        <div style={{ fontWeight: 650, marginBottom: 8 }}>Proxy (server-side)</div>
        <p className="muted" style={{ marginTop: 0 }}>
          POST to <code>/api/integrations/proxy</code> with {"{ url, method, headers, body }"}.
          The server enforces an allowlist from <code>INTEGRATION_PROXY_ALLOWLIST</code>.
        </p>
        <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12, opacity: 0.9 }}>
{`Example:
fetch("/api/integrations/proxy", {
  method: "POST",
  headers: { "Content-Type":"application/json" },
  body: JSON.stringify({ url: "https://api.example.com/v1/things", method: "GET" })
})`}
        </pre>
      </div>

      <div className="card" style={{ maxWidth: 980 }}>
        <div style={{ fontWeight: 650, marginBottom: 8 }}>Webhooks</div>
        <p className="muted" style={{ marginTop: 0 }}>
          Receive external webhooks at <code>/api/integrations/webhooks/[name]</code>.
          Store events into Supabase or forward them into your own worker.
        </p>
      </div>

      <div className="card" style={{ maxWidth: 980 }}>
        <div style={{ fontWeight: 650, marginBottom: 8 }}>Integration modules</div>
        <p className="muted" style={{ marginTop: 0 }}>
          See <code>/lib/integrations</code> for a drop-in place to add providers.
        </p>
      </div>
    </main>
  );
}