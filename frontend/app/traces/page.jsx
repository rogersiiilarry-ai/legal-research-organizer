"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

export default function TracesPage() {
  const [filter, setFilter] = useState("all");

  // Placeholder data until we wire Supabase
  const traces = useMemo(
    () => [
      { id: "t_001", type: "ingest", status: "ok", at: "2026-01-03 00:41", note: "CourtListener sync complete" },
      { id: "t_002", type: "answer", status: "blocked", at: "2026-01-03 00:44", note: "No citations provided" },
      { id: "t_003", type: "ingest", status: "running", at: "2026-01-03 00:46", note: "GovInfo job in progress" },
    ],
    []
  );

  const filtered = traces.filter((t) => (filter === "all" ? true : t.type === filter));

  return (
    <main
      style={{
        minHeight: "calc(100vh - 3rem)",
        padding: "1.8rem 1.5rem 2.5rem",
        display: "flex",
        flexDirection: "column",
        gap: "1.2rem",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
          <h1 style={{ fontSize: "1.6rem", margin: 0 }}>Traces</h1>
          <p style={{ margin: 0, fontSize: "0.95rem", opacity: 0.85 }}>
            Audit trail for ingestion jobs, citation-locked answers, and workspace actions.
          </p>
          <p style={{ margin: 0, fontSize: "0.85rem", opacity: 0.8 }}>
            Next step: bind this view to <code>audit_logs</code> and your job tables in Supabase.
          </p>
        </div>

        <div style={{ display: "flex", gap: "0.6rem", alignItems: "flex-start" }}>
          <Link
            href="/jobs"
            style={{
              padding: "0.45rem 0.8rem",
              borderRadius: "0.75rem",
              border: "1px solid rgba(148, 163, 184, 0.35)",
              fontSize: "0.85rem",
              textDecoration: "none",
              color: "rgba(226,232,240,0.92)",
            }}
          >
            View jobs
          </Link>
          <Link
            href="/dashboard"
            style={{
              padding: "0.45rem 0.8rem",
              borderRadius: "0.75rem",
              border: "1px solid rgba(148, 163, 184, 0.35)",
              fontSize: "0.85rem",
              textDecoration: "none",
              color: "rgba(226,232,240,0.92)",
            }}
          >
            Back to dashboard
          </Link>
        </div>
      </div>

      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
        <div style={{ fontSize: "0.85rem", opacity: 0.8 }}>Filter:</div>
        {["all", "ingest", "answer"].map((k) => {
          const active = filter === k;
          return (
            <button
              key={k}
              onClick={() => setFilter(k)}
              style={{
                padding: "0.35rem 0.7rem",
                borderRadius: "999px",
                border: "1px solid rgba(148, 163, 184, 0.35)",
                background: active ? "rgba(59,130,246,0.25)" : "transparent",
                color: "rgba(226,232,240,0.92)",
                cursor: "pointer",
                fontSize: "0.85rem",
              }}
            >
              {k.toUpperCase()}
            </button>
          );
        })}
      </div>

      <section
        style={{
          borderRadius: "1rem",
          border: "1px solid rgba(148, 163, 184, 0.4)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "160px 120px 160px 1fr",
            gap: "0",
            padding: "0.75rem 1rem",
            fontSize: "0.8rem",
            opacity: 0.85,
            borderBottom: "1px solid rgba(148, 163, 184, 0.25)",
          }}
        >
          <div>ID</div>
          <div>Type</div>
          <div>Status</div>
          <div>Note</div>
        </div>

        {filtered.map((t) => (
          <div
            key={t.id}
            style={{
              display: "grid",
              gridTemplateColumns: "160px 120px 160px 1fr",
              padding: "0.75rem 1rem",
              fontSize: "0.85rem",
              borderBottom: "1px solid rgba(148, 163, 184, 0.12)",
            }}
          >
            <div style={{ opacity: 0.9 }}>{t.id}</div>
            <div style={{ opacity: 0.85 }}>{t.type}</div>
            <div style={{ opacity: 0.9 }}>{t.status}</div>
            <div style={{ opacity: 0.85 }}>
              {t.note} <span style={{ opacity: 0.7 }}>({t.at})</span>
            </div>
          </div>
        ))}

        {filtered.length === 0 && (
          <div style={{ padding: "1rem", fontSize: "0.9rem", opacity: 0.8 }}>No traces match this filter.</div>
        )}
      </section>
    </main>
  );
}
