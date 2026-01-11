"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { getBrowserSupabase } from "@/lib/supabase/browserClient";

export default function DetailPage({ params }) {
  const [row, setRow] = useState(null);
  const [form, setForm] = useState({});
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const router = useRouter();
  const supabase = useMemo(() => getBrowserSupabase(), []);

  useEffect(() => {
    (async () => {
      setErr("");
      const sess = await supabase.auth.getSession();
      const token = (sess && sess.data && sess.data.session && sess.data.session.access_token) ? sess.data.session.access_token : "";
      const res = await fetch("/api/citations/" + params.id, { headers: token ? { Authorization: "Bearer " + token } : {} });
      const json = await res.json().catch(() => null);
      if (!json || !json.ok) return setErr((json && json.error) ? json.error : "Not found");
      setRow(json.data);
      setForm(json.data || {});
    })();
  }, [params.id, supabase]);

  async function onSave(e) {
    e.preventDefault();
    setErr(""); setOk("");
    const sess = await supabase.auth.getSession();
    const token = (sess && sess.data && sess.data.session && sess.data.session.access_token) ? sess.data.session.access_token : "";
    const res = await fetch("/api/citations/" + params.id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
      body: JSON.stringify(form)
    });
    const json = await res.json().catch(() => null);
    if (!json || !json.ok) return setErr((json && json.error) ? json.error : "Failed to update");
    setOk("Saved.");
    setRow(json.data);
  }

  async function onDelete() {
    if (!confirm("Delete this record?")) return;
    setErr(""); setOk("");
    const sess = await supabase.auth.getSession();
    const token = (sess && sess.data && sess.data.session && sess.data.session.access_token) ? sess.data.session.access_token : "";
    const res = await fetch("/api/citations/" + params.id, { method: "DELETE", headers: token ? { Authorization: "Bearer " + token } : {} });
    const json = await res.json().catch(() => null);
    if (!json || !json.ok) return setErr((json && json.error) ? json.error : "Failed to delete");
    router.push("/app/citations");
  }

  return (
    <main style={{ minHeight: "calc(100vh - 3.2rem)", padding: "1.6rem 1.4rem" }}>
      <div className="card" style={{ maxWidth: 720 }}>
        <h1 style={{ marginTop: 0 }}>Citation detail</h1>
        {err ? <div style={{ color: "#fca5a5", fontSize: 13 }}>{err}</div> : null}
        {ok ? <div style={{ color: "#86efac", fontSize: 13 }}>{ok}</div> : null}
        {row ? (
          <>
            <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              ID: <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{row.id}</span>
            </div>

            <form onSubmit={onSave} style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 14 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="muted" style={{ fontSize: 12 }}>Case_id</span>
            <input
              value={(form["case_id"] ? form["case_id"] : "")}
              onChange={(e) => setForm({ ...form, ["case_id"]: e.target.value })}
              style={{ width: "100%", padding: 10, borderRadius: 10, border: "1px solid rgba(148,163,184,0.35)", background: "rgba(2,6,23,0.6)", color: "#e5e7eb" }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="muted" style={{ fontSize: 12 }}>Cited_case_id</span>
            <input
              value={(form["cited_case_id"] ? form["cited_case_id"] : "")}
              onChange={(e) => setForm({ ...form, ["cited_case_id"]: e.target.value })}
              style={{ width: "100%", padding: 10, borderRadius: 10, border: "1px solid rgba(148,163,184,0.35)", background: "rgba(2,6,23,0.6)", color: "#e5e7eb" }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="muted" style={{ fontSize: 12 }}>Context</span>
            <input
              value={(form["context"] ? form["context"] : "")}
              onChange={(e) => setForm({ ...form, ["context"]: e.target.value })}
              style={{ width: "100%", padding: 10, borderRadius: 10, border: "1px solid rgba(148,163,184,0.35)", background: "rgba(2,6,23,0.6)", color: "#e5e7eb" }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="muted" style={{ fontSize: 12 }}>Citation_locked</span>
            <input
              value={(form["citation_locked"] ? form["citation_locked"] : "")}
              onChange={(e) => setForm({ ...form, ["citation_locked"]: e.target.value })}
              style={{ width: "100%", padding: 10, borderRadius: 10, border: "1px solid rgba(148,163,184,0.35)", background: "rgba(2,6,23,0.6)", color: "#e5e7eb" }}
            />
          </label>

              <div style={{ display: "flex", gap: 10, marginTop: 6, flexWrap: "wrap" }}>
                <button className="btn btn-primary" type="submit">Save</button>
                <button className="btn btn-ghost" type="button" onClick={() => router.push("/app/citations")}>Back</button>
                <button className="btn btn-ghost" type="button" onClick={onDelete} style={{ borderColor: "rgba(252, 165, 165, 0.45)" }}>
                  Delete
                </button>
              </div>
            </form>
          </>
        ) : (
          <div className="muted" style={{ marginTop: 10 }}>Loading…</div>
        )}
      </div>
    </main>
  );
}