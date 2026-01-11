"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { getBrowserSupabase } from "../../../lib/supabase/browserClient";

export default function ListPage() {
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState("");
  const supabase = useMemo(() => getBrowserSupabase(), []);

  useEffect(() => {
    (async () => {
      setErr("");
      const sess = await supabase.auth.getSession();
      const token = (sess && sess.data && sess.data.session && sess.data.session.access_token) ? sess.data.session.access_token : "";
      const res = await fetch("/api/issues", { headers: token ? { Authorization: "Bearer " + token } : {} });
      const json = await res.json().catch(() => null);
      if (!json || !json.ok) return setErr((json && json.error) ? json.error : "Failed to load");
      setRows(json.data || []);
    })();
  }, [supabase]);

  return (
    <main style={{ minHeight: "calc(100vh - 3.2rem)", padding: "1.6rem 1.4rem", display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="card" style={{ maxWidth: 1100 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 20 }}>Issues</h1>
            <p className="muted" style={{ margin: "6px 0 0" }}>List, create, and manage your Issues.</p>
          </div>
          <Link className="btn btn-primary" href={"/app/issues/new"} style={{ textDecoration: "none" }}>
            New Issue
          </Link>
        </div>
      </div>

      {err ? (
        <div className="card" style={{ maxWidth: 1100, borderColor: "rgba(252, 165, 165, 0.45)" }}>
          <div style={{ color: "#fca5a5" }}>{err}</div>
          <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
            Confirm your Supabase env keys and that you've applied migrations.
          </div>
        </div>
      ) : null}

      <div className="card" style={{ maxWidth: 1100 }}>
        {rows.length === 0 ? (
          <div className="muted">No records yet. Create your first Issue.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Created</th>
                <th>ID</th>
                <th>Open</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.created_at).toLocaleString()}</td>
                  <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 12, opacity: 0.9 }}>{r.id}</td>
                  <td>
                    <Link href={"/app/issues/" + r.id} style={{ textDecoration: "none" }}>View</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}