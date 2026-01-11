"use client";

import Link from "next/link";

export default function BuilderPage() {
  return (
    <main style={{ maxWidth: 980, margin: "40px auto", padding: "0 16px" }}>
      <header style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: "1.6rem", margin: 0 }}>Builder</h1>
          <p style={{ marginTop: 8, opacity: 0.8 }}>
            Nexus control panel for ingestion jobs, traces, and pipeline operations.
          </p>
        </div>
        <nav style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <Link href="/dashboard">Dashboard</Link>
          <Link href="/jobs">Jobs</Link>
          <Link href="/traces">Traces</Link>
          <Link href="/login">Login</Link>
        </nav>
      </header>

      <section style={{ marginTop: 24, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={card()}>
          <h2 style={h2()}>CourtListener Ingestion</h2>
          <p style={p()}>
            Queue or monitor opinion ingestion and citation extraction.
          </p>
          <button style={btn()} disabled>
            Wire to /api/jobs/courtlistener (next step)
          </button>
        </div>

        <div style={card()}>
          <h2 style={h2()}>GovInfo Ingestion</h2>
          <p style={p()}>
            Queue statutes/regulations ingestion and sync updates.
          </p>
          <button style={btn()} disabled>
            Wire to /api/jobs/govinfo (next step)
          </button>
        </div>

        <div style={card()}>
          <h2 style={h2()}>Operations Queue</h2>
          <p style={p()}>
            Show queued jobs, owners, SLA timers, and links to traces.
          </p>
          <button style={btn()} disabled>
            Wire to Supabase tables (next step)
          </button>
        </div>

        <div style={card()}>
          <h2 style={h2()}>Recent Activity</h2>
          <p style={p()}>
            Audit logs and automation traces (Orchestrator / Bridge / jobs).
          </p>
          <button style={btn()} disabled>
            Wire to audit_logs (next step)
          </button>
        </div>
      </section>
    </main>
  );
}

function card() {
  return {
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 14,
    padding: 16,
    background: "rgba(255,255,255,0.04)",
  };
}
function h2() {
  return { margin: 0, fontSize: "1.1rem" };
}
function p() {
  return { marginTop: 8, opacity: 0.8, lineHeight: 1.4 };
}
function btn() {
  return {
    marginTop: 12,
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.16)",
    background: "rgba(255,255,255,0.06)",
    cursor: "not-allowed",
    opacity: 0.75,
    textAlign: "left",
  };
}
