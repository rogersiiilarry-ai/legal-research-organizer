"use client";

// frontend/app/app/search/page.jsx
import { useMemo, useState } from "react";

export default function SearchPage() {
  const [q, setQ] = useState("miranda");
  const [mode, setMode] = useState("topic");
  const [level, setLevel] = useState("trial");
  const [region, setRegion] = useState("mi_surrounding");
  const [filedAfter, setFiledAfter] = useState("2010-01-01");
  const [sort, setSort] = useState("dateFiled_desc");
  const [limit, setLimit] = useState(10);
  const [strict, setStrict] = useState(false);

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [results, setResults] = useState([]);

  const body = useMemo(
    () => ({
      q,
      mode,
      region,
      level,
      filedAfter,
      sort,
      limit: Number(limit) || 10,
      strict: !!strict,
    }),
    [q, mode, region, level, filedAfter, sort, limit, strict]
  );

  async function runSearch() {
    setErr("");
    setLoading(true);
    setResults([]);

    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify(body),
      });

      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Search failed");

      setResults(Array.isArray(j?.results) ? j.results : []);
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ padding: "1.6rem 1.4rem", maxWidth: 1100, margin: "0 auto" }}>
      <h1 style={{ marginTop: 0 }}>Search</h1>
      <p className="muted" style={{ marginTop: 6 }}>
        CourtListener search (query-driven relevance + snippet enrichment).
      </p>

      <div className="card" style={{ marginTop: 14 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <label>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              Query (q)
            </div>
            <input value={q} onChange={(e) => setQ(e.target.value)} style={{ width: "100%", padding: 10, borderRadius: 10 }} />
          </label>

          <label>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              Region
            </div>
            <input value={region} onChange={(e) => setRegion(e.target.value)} style={{ width: "100%", padding: 10, borderRadius: 10 }} />
          </label>

          <label>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              Mode
            </div>
            <select value={mode} onChange={(e) => setMode(e.target.value)} style={{ width: "100%", padding: 10, borderRadius: 10 }}>
              <option value="topic">topic</option>
              <option value="keyword">keyword</option>
            </select>
          </label>

          <label>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              Level
            </div>
            <select value={level} onChange={(e) => setLevel(e.target.value)} style={{ width: "100%", padding: 10, borderRadius: 10 }}>
              <option value="trial">trial</option>
              <option value="appeal">appeal</option>
              <option value="all">all</option>
            </select>
          </label>

          <label>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              Filed After
            </div>
            <input value={filedAfter} onChange={(e) => setFiledAfter(e.target.value)} style={{ width: "100%", padding: 10, borderRadius: 10 }} />
          </label>

          <label>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              Sort
            </div>
            <input value={sort} onChange={(e) => setSort(e.target.value)} style={{ width: "100%", padding: 10, borderRadius: 10 }} />
          </label>

          <label>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              Limit
            </div>
            <input
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value || 10))}
              type="number"
              min={1}
              max={50}
              style={{ width: "100%", padding: 10, borderRadius: 10 }}
            />
          </label>

          <label style={{ display: "flex", alignItems: "end", gap: 8 }}>
            <input checked={strict} onChange={(e) => setStrict(e.target.checked)} type="checkbox" />
            <span className="muted">Strict filtering</span>
          </label>
        </div>

        <div style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "center" }}>
          <button className="btn btn-primary" type="button" disabled={loading} onClick={runSearch}>
            {loading ? "Searching..." : "Run Search"}
          </button>
          {err ? <div style={{ color: "#fca5a5" }}>{err}</div> : null}
        </div>

        <div style={{ marginTop: 14 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
            Request Body Preview
          </div>
          <pre style={{ margin: 0, padding: 12, borderRadius: 12, overflowX: "auto" }}>
            {JSON.stringify(body, null, 2)}
          </pre>
        </div>
      </div>

      <h2 style={{ marginTop: 18 }}>Results</h2>
      {results.length === 0 ? (
        <div className="muted">No results yet.</div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {results.map((r, idx) => (
            <div key={r?.id || idx} className="card">
              <div style={{ fontWeight: 650 }}>{r?.title || r?.caseName || "Result"}</div>
              {r?.snippet ? <div className="muted" style={{ marginTop: 6 }}>{r.snippet}</div> : null}
              {r?.url ? (
                <div style={{ marginTop: 8 }}>
                  <a href={r.url} target="_blank" rel="noreferrer">Open source</a>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
