"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/* ------------------------------ utils ------------------------------ */

function s(v: unknown) {
  return typeof v === "string" ? v.trim() : "";
}

function uiError(v: unknown) {
  return s(v) || "Something went wrong.";
}

/* ------------------------------ types ------------------------------ */

type DocumentRow = { id: string; title?: string | null };
type AnalysisRow = { id?: string; status?: string | null; summary?: string | null };

/* ------------------------------ component ------------------------------ */

export default function AuditClient() {
  const router = useRouter();
  const sp = useSearchParams();

  const analysisIdFromQuery = s(sp.get("analysisId"));
  const paidMarker = s(sp.get("paid")).toLowerCase(); // "basic" | "pro"

  const [docs, setDocs] = useState<DocumentRow[]>([]);
  const [docId, setDocId] = useState("");
  const [analysis, setAnalysis] = useState<AnalysisRow | null>(null);

  const [tier, setTier] = useState<"basic" | "pro">("basic");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");

  const didAutoMaterialize = useRef(false);

  /* ------------------------------ helpers ------------------------------ */

  async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const r = await fetch(url, {
      credentials: "include",
      cache: "no-store",
      ...(init || {}),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error || `Request failed (${r.status})`);
    return j;
  }

  async function isAdmin(): Promise<boolean> {
    try {
      const r = await fetchJson<{ admin: boolean }>("/api/me/admin");
      return r.admin === true;
    } catch {
      return false;
    }
  }

  function stripeLink(t: "basic" | "pro") {
    return t === "pro"
      ? "https://buy.stripe.com/3cIcN46YGf7Acx599V0x201"
      : "https://buy.stripe.com/fZu28qfvcf7AdB9adZ0x200";
  }

  /* ------------------------------ load docs ------------------------------ */

  useEffect(() => {
    fetchJson<{ documents: DocumentRow[] }>("/api/documents?limit=25")
      .then((r) => {
        setDocs(r.documents || []);
        if (r.documents?.[0]) setDocId(r.documents[0].id);
      })
      .catch((e) => setErr(uiError(e.message)));
  }, []);

  /* ------------------------------ load analysis ------------------------------ */

  useEffect(() => {
    if (!analysisIdFromQuery) return;
    fetchJson<{ analysis: AnalysisRow }>(`/api/analyses/${analysisIdFromQuery}`)
      .then((r) => setAnalysis(r.analysis))
      .catch((e) => setErr(uiError(e.message)));
  }, [analysisIdFromQuery]);

  /* ------------------------------ admin / payment logic ------------------------------ */

  async function materialize(documentId: string, tier: "basic" | "pro") {
    setLoading(true);
    try {
      const r = await fetchJson<{ analysisId: string }>("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "materialize-and-run",
          document_id: documentId,
          tier,
        }),
      });

      router.replace(`/audit?analysisId=${r.analysisId}`);
      router.refresh();
      setInfo("Materialized.");
    } finally {
      setLoading(false);
    }
  }

  async function onMaterialize(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setInfo("");

    if (!docId) return setErr("No document selected");

    // 🔥 ADMIN SHORT-CIRCUIT
    if (await isAdmin()) {
      setInfo("Admin detected. Skipping payment.");
      return materialize(docId, tier);
    }

    // Normal users → Stripe
    window.location.assign(stripeLink(tier));
  }

  /* ------------------------------ auto-run after Stripe ------------------------------ */

  useEffect(() => {
    if (!paidMarker || didAutoMaterialize.current) return;
    if (!docId || analysisIdFromQuery) return;

    didAutoMaterialize.current = true;
    materialize(docId, paidMarker as "basic" | "pro").catch((e) =>
      setErr(uiError(e.message))
    );
  }, [paidMarker, docId, analysisIdFromQuery]);

  /* ------------------------------ execute ------------------------------ */

  async function onExecute() {
    if (!analysisIdFromQuery) return;
    setLoading(true);
    try {
      await fetchJson("/api/audit/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ analysisId: analysisIdFromQuery, tier }),
      });
      const refreshed = await fetchJson<{ analysis: AnalysisRow }>(
        `/api/analyses/${analysisIdFromQuery}`
      );
      setAnalysis(refreshed.analysis);
      setInfo("Executed.");
    } catch (e: any) {
      setErr(uiError(e.message));
    } finally {
      setLoading(false);
    }
  }

  /* ------------------------------ render ------------------------------ */

  return (
    <div style={{ padding: 24, maxWidth: 900, margin: "0 auto" }}>
      <h1>Audit</h1>

      {err && <div style={{ color: "red" }}>{err}</div>}
      {info && <div>{info}</div>}

      {/* Step 1 */}
      <form onSubmit={onMaterialize}>
        <h3>Step 1 — Materialize</h3>

        <select value={docId} onChange={(e) => setDocId(e.target.value)}>
          {docs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title || d.id}
            </option>
          ))}
        </select>

        <div>
          <label>
            <input
              type="radio"
              checked={tier === "basic"}
              onChange={() => setTier("basic")}
            />
            Basic ($50)
          </label>

          <label>
            <input
              type="radio"
              checked={tier === "pro"}
              onChange={() => setTier("pro")}
            />
            Pro ($100)
          </label>
        </div>

        <button disabled={loading}>Pay & Materialize</button>
      </form>

      {/* Step 2 */}
      <div style={{ marginTop: 20 }}>
        <h3>Step 2 — Execute</h3>
        <button onClick={onExecute} disabled={!analysisIdFromQuery || loading}>
          Execute Audit
        </button>
      </div>

      {analysis && (
        <pre style={{ marginTop: 20 }}>
          {JSON.stringify(analysis, null, 2)}
        </pre>
      )}
    </div>
  );
}
