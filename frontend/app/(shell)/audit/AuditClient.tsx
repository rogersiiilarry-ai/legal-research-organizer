"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

type DocumentRow = { id: string; title?: string | null; raw?: any | null };
type AnalysisRow = { id?: string; status?: string | null; summary?: string | null; meta?: any };

function s(v: unknown) {
  return typeof v === "string" ? v.trim() : "";
}

function pickDocTitle(d: DocumentRow) {
  return (
    s(d?.title) ||
    s(d?.raw?.caseName) ||
    s(d?.raw?.case_name) ||
    s(d?.raw?.name) ||
    s(d?.id) ||
    "Untitled"
  );
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, {
    credentials: "include",
    cache: "no-store",
    ...(init || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || j?.message || `Request failed (${r.status})`);
  return j as T;
}

function stripeLink(tier: "basic" | "pro") {
  return tier === "pro"
    ? "https://buy.stripe.com/3cIcN46YGf7Acx599V0x201"
    : "https://buy.stripe.com/fZu28qfvcf7AdB9adZ0x200";
}

export default function AuditClient() {
  const router = useRouter();
  const sp = useSearchParams();

  const analysisId = s(sp.get("analysisId"));
  const [docs, setDocs] = useState<DocumentRow[]>([]);
  const [docId, setDocId] = useState("");
  const [analysis, setAnalysis] = useState<AnalysisRow | null>(null);

  const [tier, setTier] = useState<"basic" | "pro">("basic");
  const [admin, setAdmin] = useState(false);

  const [busy, setBusy] = useState<"idle" | "loading" | "materialize" | "execute">("idle");
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");

  // prevent double clicks
  const lockRef = useRef(false);

  const canMaterialize = useMemo(() => !!docId && busy === "idle", [docId, busy]);
  const canExecute = useMemo(() => !!analysisId && busy === "idle", [analysisId, busy]);

  // Load admin flag (server truth)
  useEffect(() => {
    fetchJson<{ ok?: boolean; admin?: boolean }>("/api/me/admin")
      .then((r) => setAdmin(r.admin === true))
      .catch(() => setAdmin(false));
  }, []);

  // Load docs
  useEffect(() => {
    let cancelled = false;
    setBusy("loading");
    fetchJson<{ documents?: DocumentRow[] }>("/api/documents?limit=50")
      .then((r) => {
        if (cancelled) return;
        const list = Array.isArray(r.documents) ? r.documents : [];
        setDocs(list);
        if (!docId) setDocId(list?.[0]?.id || "");
      })
      .catch((e: any) => !cancelled && setErr(e.message))
      .finally(() => !cancelled && setBusy("idle"));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load analysis when query changes
  useEffect(() => {
    let cancelled = false;
    if (!analysisId) {
      setAnalysis(null);
      return;
    }
    fetchJson<any>(`/api/analyses/${encodeURIComponent(analysisId)}`)
      .then((r) => {
        if (cancelled) return;
        setAnalysis((r.analysis || r.data || r.row || r.analysisRow || null) as AnalysisRow | null);
      })
      .catch((e: any) => !cancelled && setErr(e.message));
    return () => {
      cancelled = true;
    };
  }, [analysisId]);

  async function materializeNow(selectedTier: "basic" | "pro") {
    if (!docId) throw new Error("No document selected.");

    setErr("");
    setInfo("");
    setBusy("materialize");

    const r = await fetchJson<{ analysisId?: string; analysis_id?: string }>("/api/research", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "materialize-and-run",
        kind: "case_fact_audit",
        document_id: docId,
        tier: selectedTier,
        withPdf: selectedTier === "pro",
      }),
    });

    const newId = s(r.analysisId || (r as any).analysis_id);
    if (!newId) throw new Error("Materialize did not return analysisId.");

    router.replace(`/audit?analysisId=${encodeURIComponent(newId)}`);
    router.refresh();
    setInfo("Materialized.");
    setBusy("idle");
  }

  async function onMaterializeClick() {
    if (lockRef.current) return;
    lockRef.current = true;
    try {
      setErr("");
      setInfo("");

      // Admin: server bypass, no Stripe, no tier pricing UI needed
      if (admin) {
        await materializeNow("pro"); // admins get pro behavior (export etc.)
        return;
      }

      // Non-admin: go to Stripe
      window.location.assign(stripeLink(tier));
    } finally {
      lockRef.current = false;
    }
  }

  async function onExecuteClick() {
    if (!analysisId) return;
    if (lockRef.current) return;

    lockRef.current = true;
    setErr("");
    setInfo("");
    setBusy("execute");

    try {
      const exec = await fetchJson<any>("/api/audit/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          analysisId,
          tier: admin ? "pro" : tier,
        }),
      });

      // If server says payment required, that’s a server entitlement problem.
      if (exec?.requires_payment === true || String(exec?.code || "").toUpperCase() === "PAYMENT_REQUIRED") {
        throw new Error("Payment required. (Admins should never see this — server entitlement check is blocking.)");
      }

      // Refresh analysis
      const refreshed = await fetchJson<any>(`/api/analyses/${encodeURIComponent(analysisId)}`);
      setAnalysis((refreshed.analysis || refreshed.data || refreshed.row || refreshed.analysisRow || null) as AnalysisRow | null);

      setInfo("Executed.");
    } catch (e: any) {
      setErr(e.message || "Execute failed.");
    } finally {
      setBusy("idle");
      lockRef.current = false;
    }
  }

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: 24 }}>
      <h1 style={{ fontSize: 26, marginBottom: 6 }}>Audit</h1>
      <p style={{ opacity: 0.8, marginBottom: 18 }}>
        Research-only fact audit. Generates findings about factual consistency, inconsistencies, and source coverage.
      </p>

      {err ? <div style={{ marginBottom: 12, color: "#fca5a5", whiteSpace: "pre-wrap" }}>{err}</div> : null}
      {info ? <div style={{ marginBottom: 12, opacity: 0.9 }}>{info}</div> : null}

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ fontWeight: 700 }}>Step 1 — Materialize</div>
          {admin ? <div style={{ fontSize: 12, opacity: 0.8 }}>Admin Mode (no payment)</div> : null}
        </div>

        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>Document</div>
          <select
            value={docId}
            onChange={(e) => setDocId(e.target.value)}
            disabled={busy !== "idle" && busy !== "loading"}
            style={{
              width: "100%",
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,.14)",
              background: "rgba(0,0,0,.18)",
            }}
          >
            {docs.map((d) => (
              <option key={d.id} value={d.id}>
                {pickDocTitle(d)}
              </option>
            ))}
          </select>
        </div>

        {!admin ? (
          <div style={{ marginTop: 12, display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ fontSize: 12, opacity: 0.8 }}>Tier</div>
            <label style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
              <input type="radio" checked={tier === "basic"} onChange={() => setTier("basic")} />
              <span>Basic ($50)</span>
            </label>
            <label style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
              <input type="radio" checked={tier === "pro"} onChange={() => setTier("pro")} />
              <span>Pro ($100)</span>
            </label>
          </div>
        ) : null}

        <div style={{ marginTop: 14 }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onMaterializeClick}
            disabled={!canMaterialize}
            style={{ opacity: canMaterialize ? 1 : 0.6 }}
          >
            {busy === "materialize" ? "Materializing..." : admin ? "Materialize (Admin)" : "Pay & Materialize"}
          </button>
        </div>
      </div>

      <div className="card">
        <div style={{ fontWeight: 700, marginBottom: 10 }}>Step 2 — Execute</div>

        <button
          type="button"
          className="btn btn-primary"
          onClick={onExecuteClick}
          disabled={!canExecute}
          style={{ opacity: canExecute ? 1 : 0.6 }}
        >
          {busy === "execute" ? "Executing..." : "Execute Audit"}
        </button>

        {analysis ? (
          <div style={{ marginTop: 14, opacity: 0.9 }}>
            <div style={{ fontSize: 12, opacity: 0.8 }}>Status</div>
            <div>{s(analysis.status) || "—"}</div>

            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.8 }}>Summary</div>
            <div style={{ whiteSpace: "pre-wrap" }}>{s(analysis.summary) || "—"}</div>
          </div>
        ) : (
          <div style={{ marginTop: 12, opacity: 0.75 }}>No analysis loaded yet.</div>
        )}
      </div>
    </div>
  );
}
