"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { getBrowserSupabase } from "@/lib/supabase/browserClient";

export default function NewPage() {
  const [form, setForm] = useState({});
  const [err, setErr] = useState("");
  const router = useRouter();
  const supabase = useMemo(() => getBrowserSupabase(), []);

  async function onSubmit(e) {
    e.preventDefault();
    setErr("");
    const sess = await supabase.auth.getSession();
    const token = (sess && sess.data && sess.data.session && sess.data.session.access_token) ? sess.data.session.access_token : "";
    const res = await fetch("/api/cases", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
      body: JSON.stringify(form)
    });
    const json = await res.json().catch(() => null);
    if (!json || !json.ok) return setErr((json && json.error) ? json.error : "Failed to create");
    router.push("/app/cases/" + json.data.id);
  }

  return (
    <main style={{ minHeight: "calc(100vh - 3.2rem)", padding: "1.6rem 1.4rem" }}>
      <div className="card" style={{ maxWidth: 720 }}>
        <h1 style={{ marginTop: 0 }}>New Case</h1>
        <p className="muted" style={{ marginTop: 6 }}>Create a new Case record in Supabase.</p>

        <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 14 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="muted" style={{ fontSize: 12 }}>Title</span>
            <input
              value={(form["title"] ? form["title"] : "")}
              onChange={(e) => setForm({ ...form, ["title"]: e.target.value })}
              style={{ width: "100%", padding: 10, borderRadius: 10, border: "1px solid rgba(148,163,184,0.35)", background: "rgba(2,6,23,0.6)", color: "#e5e7eb" }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="muted" style={{ fontSize: 12 }}>Court</span>
            <input
              value={(form["court"] ? form["court"] : "")}
              onChange={(e) => setForm({ ...form, ["court"]: e.target.value })}
              style={{ width: "100%", padding: 10, borderRadius: 10, border: "1px solid rgba(148,163,184,0.35)", background: "rgba(2,6,23,0.6)", color: "#e5e7eb" }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="muted" style={{ fontSize: 12 }}>Decision_date</span>
            <input
              value={(form["decision_date"] ? form["decision_date"] : "")}
              onChange={(e) => setForm({ ...form, ["decision_date"]: e.target.value })}
              style={{ width: "100%", padding: 10, borderRadius: 10, border: "1px solid rgba(148,163,184,0.35)", background: "rgba(2,6,23,0.6)", color: "#e5e7eb" }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="muted" style={{ fontSize: 12 }}>Citation</span>
            <input
              value={(form["citation"] ? form["citation"] : "")}
              onChange={(e) => setForm({ ...form, ["citation"]: e.target.value })}
              style={{ width: "100%", padding: 10, borderRadius: 10, border: "1px solid rgba(148,163,184,0.35)", background: "rgba(2,6,23,0.6)", color: "#e5e7eb" }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="muted" style={{ fontSize: 12 }}>Summary</span>
            <input
              value={(form["summary"] ? form["summary"] : "")}
              onChange={(e) => setForm({ ...form, ["summary"]: e.target.value })}
              style={{ width: "100%", padding: 10, borderRadius: 10, border: "1px solid rgba(148,163,184,0.35)", background: "rgba(2,6,23,0.6)", color: "#e5e7eb" }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="muted" style={{ fontSize: 12 }}>Full_text</span>
            <input
              value={(form["full_text"] ? form["full_text"] : "")}
              onChange={(e) => setForm({ ...form, ["full_text"]: e.target.value })}
              style={{ width: "100%", padding: 10, borderRadius: 10, border: "1px solid rgba(148,163,184,0.35)", background: "rgba(2,6,23,0.6)", color: "#e5e7eb" }}
            />
          </label>

          {err ? <div style={{ color: "#fca5a5", fontSize: 13 }}>{err}</div> : null}

          <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
            <button className="btn btn-primary" type="submit">Create</button>
            <button className="btn btn-ghost" type="button" onClick={() => router.push("/app/cases")}>Cancel</button>
          </div>
        </form>
      </div>
    </main>
  );
}
