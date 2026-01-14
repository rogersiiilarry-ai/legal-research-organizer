"use client";

// frontend/app/(shell)/audit/AuditClient.tsx
import React, { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/* ------------------------------ small utils ------------------------------ */

function safeStr(v: unknown) {
  return typeof v === "string" ? v : "";
}

function clampStr(v: unknown, max = 4000) {
  const s = safeStr(v).trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max) : s;
}

function normalizeUiError(message: unknown) {
  const m = safeStr(message).trim();
  if (!m) return "Something went wrong.";

  if (/<!doctype html/i.test(m) || /text\/html/i.test(m) || /returned html/i.test(m)) {
    return `${m}\n\nHint: That URL returned HTML. Use a direct PDF download link or upload the PDF.`;
  }

  return m;
}

/* ------------------------------ types ------------------------------ */

type JsonRecord = Record<string, any>;

type DocumentRow = {
  id: string;
  title?: string | null;
  external_id?: string | null;
  caseName?: string | null;
  case_name?: string | null;
  name?: string | null;
  raw?: JsonRecord | null;
};

type Finding = {
  id?: string | null;
  title?: string | null;
  severity?: string | null;
  claim?: string | null;
  detail?: string | null;
  evidence?: unknown;
};

type AnalysisRow = {
  id?: string;
  status?: string | null;
  summary?: string | null;
  target_document_id?: string | null;
  meta?: JsonRecord | string | null;
  findings?: Finding[] | { rows?: Finding[] } | null;
};

type DocumentsResponse = {
  ok?: boolean;
  documents?: DocumentRow[];
};

type AnalysisResponse = {
  ok?: boolean;
  analysisId?: string;
  analysis_id?: string;
  analysis?: AnalysisRow;
  data?: AnalysisRow;
  row?: AnalysisRow;
  analysisRow?: AnalysisRow;
  meta?: JsonRecord | string;
  findings?: Finding[] | { rows?: Finding[] };
  exportAllowed?: boolean;
  export_allowed?: boolean;
};

type ExecuteResponse = {
  ok?: boolean;
  error?: string;
  message?: string;

  requires_payment?: boolean;
  code?: string;

  findings?: Finding[];
  tier?: "basic" | "pro" | string;
  exportAllowed?: boolean;
  summary?: string;

  // in case server returns it
  checkout_url?: string;
  url?: string;
};

type MaterializeResponse = {
  ok?: boolean;
  analysisId?: string;
  analysis_id?: string;
  error?: string;
  message?: string;

  // paywall return
  checkout_url?: string;
  url?: string;
};

type CheckoutResponse = {
  ok?: boolean;
  url?: string;
  checkout_url?: string;
  error?: string;
  message?: string;
};

/* ------------------------------ helpers ------------------------------ */

function pickDocTitle(d: DocumentRow) {
  return (
    clampStr(d?.title, 240) ||
    clampStr(d?.raw?.caseName, 240) ||
    clampStr(d?.raw?.case_name, 240) ||
    clampStr(d?.caseName, 240) ||
    clampStr(d?.case_name, 240) ||
    clampStr(d?.name, 240) ||
    clampStr(d?.external_id, 240) ||
    clampStr(d?.id, 240) ||
    "Untitled"
  );
}

function resolveAnalysisRow(payload: AnalysisResponse | null): AnalysisRow | null {
  if (!payload || typeof payload !== "object") return null;
  return (payload.analysis || payload.data || payload.row || payload.analysisRow || null) as AnalysisRow | null;
}

function resolveMeta(analysisRow: AnalysisRow | null, payload: AnalysisResponse | null): JsonRecord {
  const p = (payload || {}) as any;
  const raw = (analysisRow?.meta ?? p?.meta ?? null) as unknown;

  if (!raw) return {};

  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as JsonRecord) : {};
    } catch {
      return {};
    }
  }

  if (typeof raw === "object") return raw as JsonRecord;
  return {};
}

function resolveFindings(payload: AnalysisResponse | null): Finding[] {
  const p = (payload || {}) as any;
  const analysis = resolveAnalysisRow(payload);
  const meta = resolveMeta(analysis, payload);

  const candidates: unknown[] = [
    p.findings,
    p.findings?.rows,
    analysis?.findings,
    (analysis as any)?.findings?.rows,
    meta?.findings,
    meta?.findings?.rows,
    meta?.result?.findings,
    meta?.output?.findings,
  ];

  for (const c of candidates) {
    if (Array.isArray(c)) return c as Finding[];
  }
  return [];
}

function resolveTier(payload: AnalysisResponse | null): "basic" | "pro" | null {
  const analysis = resolveAnalysisRow(payload);
  const meta = resolveMeta(analysis, payload);
  const t = safeStr(meta?.tier || meta?.executed_tier || "").toLowerCase();
  return t === "basic" || t === "pro" ? (t as "basic" | "pro") : null;
}

function resolvePaid(payload: AnalysisResponse | null): boolean {
  const analysis = resolveAnalysisRow(payload);
  const meta = resolveMeta(analysis, payload);
  return meta?.paid === true;
}

function resolveExportAllowed(payload: AnalysisResponse | null): boolean {
  const p = (payload || {}) as any;
  const analysis = resolveAnalysisRow(payload);
  const meta = resolveMeta(analysis, payload);

  if (typeof p.exportAllowed === "boolean") return p.exportAllowed;
  if (typeof p.export_allowed === "boolean") return p.export_allowed;

  if (typeof meta.exportAllowed === "boolean") return meta.exportAllowed;
  if (typeof meta.export_allowed === "boolean") return meta.export_allowed;

  const t = safeStr(meta?.tier || meta?.executed_tier || "").toLowerCase();
  return t === "pro";
}

function formatStatus(analysisRow: AnalysisRow | null) {
  const s = safeStr(analysisRow?.status || "").trim();
  return s || "—";
}

function formatSummary(analysisRow: AnalysisRow | null) {
  const s = safeStr(analysisRow?.summary || "").trim();
  return s || "—";
}

function pickCheckoutUrl(payload: any): string {
  const u = safeStr(payload?.checkout_url || payload?.url).trim();
  return u;
}

/* ------------------------------ component ------------------------------ */

export default function AuditClient() {
  const router = useRouter();
  const sp = useSearchParams();

  const analysisIdFromQuery = (sp.get("analysisId") || "").trim();
  const initialDocId = (sp.get("documentId") || sp.get("document_id") || "").trim();

  const [docs, setDocs] = useState<DocumentRow[]>([]);
  const [docId, setDocId] = useState<string>("");

  const [analysisPayload, setAnalysisPayload] = useState<AnalysisResponse | null>(null);

  const [err, setErr] = useState<string>("");
  const [info, setInfo] = useState<string>("");

  const [loadingDocs, setLoadingDocs] = useState<boolean>(true);
  const [runningMaterialize, setRunningMaterialize] = useState<boolean>(false);
  const [runningExecute, setRunningExecute] = useState<boolean>(false);

  const [tierChoice, setTierChoice] = useState<"basic" | "pro">("basic");

  function setUiErr(message: unknown) {
    setErr(normalizeUiError(message));
  }

  async function fetchJsonOk<T = any>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, {
      cache: "no-store",
      credentials: "include",
      ...(init || {}),
    });

    const j = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new Error(j?.error || j?.message || `Request failed (${res.status})`);
    return j as T;
  }

  async function fetchAnalysis(id: string) {
    return await fetchJsonOk<AnalysisResponse>(`/api/analyses/${encodeURIComponent(id)}`);
  }

  async function startCheckout(analysisId: string, tier: "basic" | "pro") {
    const cj = await fetchJsonOk<CheckoutResponse>("/api/stripe/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ analysisId, tier }),
    });

    const url = pickCheckoutUrl(cj);
    if (!url) throw new Error(cj?.error || cj?.message || "Failed to start checkout");

    window.location.assign(url);
  }

  /* ------------------------------ load documents ------------------------------ */

  useEffect(() => {
    let cancelled = false;

    async function loadDocs() {
      setLoadingDocs(true);
      setErr("");
      setInfo("");

      try {
        const j = await fetchJsonOk<DocumentsResponse>(`/api/documents?limit=50`);
        const list = Array.isArray(j?.documents) ? j.documents : [];
        if (cancelled) return;

        setDocs(list);

        if (initialDocId && list.some((d) => d.id === initialDocId)) {
          setDocId(initialDocId);
        } else {
          setDocId(list?.[0]?.id || "");
        }
      } catch (e: any) {
        if (!cancelled) setUiErr(e?.message || "Failed to load documents");
      } finally {
        if (!cancelled) setLoadingDocs(false);
      }
    }

    loadDocs();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------------ load analysis (if query param) ------------------------------ */

  useEffect(() => {
    let cancelled = false;

    async function loadAnalysis() {
      setErr("");
      setInfo("");

      if (!analysisIdFromQuery) {
        setAnalysisPayload(null);
        return;
      }

      try {
        const payload = await fetchAnalysis(analysisIdFromQuery);
        if (cancelled) return;
        setAnalysisPayload(payload);
      } catch (e: any) {
        if (!cancelled) setUiErr(e?.message || "Failed to load analysis");
      }
    }

    loadAnalysis();
    return () => {
      cancelled = true;
    };
  }, [analysisIdFromQuery]);

  /* ------------------------------ derived view models ------------------------------ */

  const shownAnalysisId = useMemo(() => {
    return String((analysisPayload as any)?.analysisId || analysisIdFromQuery || "").trim();
  }, [analysisPayload, analysisIdFromQuery]);

  const analysisRow = useMemo(() => resolveAnalysisRow(analysisPayload), [analysisPayload]);

  const findings = useMemo(() => resolveFindings(analysisPayload), [analysisPayload]);
  const exportAllowed = useMemo(() => resolveExportAllowed(analysisPayload), [analysisPayload]);
  const tierDetected = useMemo(() => resolveTier(analysisPayload), [analysisPayload]);
  const paidDetected = useMemo(() => resolvePaid(analysisPayload), [analysisPayload]);

  const canMaterialize = useMemo(() => {
    return !!docId && !runningMaterialize && !runningExecute;
  }, [docId, runningMaterialize, runningExecute]);

  const canExecute = useMemo(() => {
    const id = safeStr((analysisPayload as any)?.analysisId || analysisIdFromQuery).trim();
    return !!id && !runningMaterialize && !runningExecute;
  }, [analysisPayload, analysisIdFromQuery, runningMaterialize, runningExecute]);

  /* ------------------------------ actions ------------------------------ */

  async function onMaterialize(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setInfo("");

    if (!docId) return setUiErr("document_id is required");

    setRunningMaterialize(true);
    try {
      // IMPORTANT: do NOT use fetchJsonOk here because we must handle 402 payload.
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "include",
        cache: "no-store",
        body: JSON.stringify({
          mode: "materialize-and-run",
          document_id: docId,
          kind: "case_fact_audit",
          tier: tierChoice, // let server know which checkout price to use
          withPdf: tierChoice === "pro",
          materialize: { maxChars: 4000, maxChunks: 250, timeoutMs: 45000 },
        }),
      });

      const j = (await res.json().catch(() => ({}))) as MaterializeResponse;

      // If unpaid, redirect immediately to Stripe
      if (res.status === 402) {
        const checkoutUrl = pickCheckoutUrl(j);
        if (!checkoutUrl) throw new Error(j?.error || j?.message || "Payment required, but no checkout URL returned");
        window.location.assign(checkoutUrl);
        return;
      }

      if (!res.ok) {
        throw new Error((j as any)?.error || (j as any)?.message || `Materialize failed (${res.status})`);
      }

      const newAnalysisId = String(j?.analysisId || (j as any)?.analysis_id || "").trim();
      if (!newAnalysisId) throw new Error("No analysisId returned");

      router.replace(`/audit?analysisId=${encodeURIComponent(newAnalysisId)}`);
      router.refresh();

      setInfo("Materialized successfully. Next step: execute the audit to generate findings.");
    } catch (e2: any) {
      setUiErr(e2?.message || "Materialize failed");
    } finally {
      setRunningMaterialize(false);
    }
  }

  async function onExecute(e: React.MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    setErr("");
    setInfo("");

    const id = String((analysisPayload as any)?.analysisId || analysisIdFromQuery || "").trim();
    if (!id) return setUiErr("analysisId is required");

    setRunningExecute(true);
    try {
      const res = await fetch("/api/audit/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        cache: "no-store",
        body: JSON.stringify({ analysisId: id, tier: tierChoice }),
      });

      const exec = (await res.json().catch(() => ({}))) as ExecuteResponse;

      const requiresPayment =
        res.status === 402 ||
        exec?.requires_payment === true ||
        String(exec?.code || "").toUpperCase() === "PAYMENT_REQUIRED";

      if (requiresPayment) {
        setErr("");
        setInfo("Payment required. Redirecting to Stripe Checkout…");
        await startCheckout(id, tierChoice);
        return;
      }

      if (!res.ok) {
        throw new Error((exec as any)?.error || (exec as any)?.message || `Execute failed (${res.status})`);
      }

      const refreshed = await fetchAnalysis(id);
      setAnalysisPayload(refreshed);

      setInfo(
        resolveExportAllowed(refreshed)
          ? "Audit executed. Pro tier detected: PDF export is allowed."
          : "Audit executed. Basic tier detected: PDF export is disabled."
      );
    } catch (e2: any) {
      setUiErr(e2?.message || "Execute failed");
    } finally {
      setRunningExecute(false);
    }
  }

  async function onRefresh() {
    setErr("");
    setInfo("");

    const id = String((analysisPayload as any)?.analysisId || analysisIdFromQuery || "").trim();
    if (!id) return;

    try {
      const refreshed = await fetchAnalysis(id);
      setAnalysisPayload(refreshed);
      setInfo("Refreshed.");
    } catch (e2: any) {
      setUiErr(e2?.message || "Refresh failed");
    }
  }

  function onExportPdf() {
    setErr("");
    setInfo("");

    if (!exportAllowed) return;

    const id = String(shownAnalysisId || "").trim();
    if (!id) return setUiErr("No analysis available to export.");

    window.open(`/api/audit/export/pdf?analysisId=${encodeURIComponent(id)}`, "_blank", "noopener,noreferrer");
  }

  /* ------------------------------ render ------------------------------ */

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <h1 style={{ fontSize: 22, marginBottom: 8, color: "#f8fafc" }}>Audit</h1>
      <p style={{ opacity: 0.9, marginBottom: 18, color: "rgba(248,250,252,.82)" }}>
        Research-only fact audit. Generates findings about factual consistency, inconsistencies, and source coverage.
      </p>

      {/* Step 1 */}
      <div className="card" style={{ marginBottom: 18 }}>
        <div style={{ fontWeight: 700, marginBottom: 10, color: "#f8fafc" }}>
          Step 1 — Materialize (PDF → searchable chunks)
        </div>

        <form onSubmit={onMaterialize}>
          <label style={{ display: "block", marginBottom: 8, fontSize: 13, color: "rgba(248,250,252,.78)" }}>
            Document
          </label>

          <select
            value={docId}
            onChange={(e) => setDocId(e.target.value)}
            style={{
              width: "100%",
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,.16)",
              background: "rgba(0,0,0,.25)",
              color: "#f8fafc",
              marginBottom: 12,
              outline: "none",
            }}
            disabled={loadingDocs}
            required
          >
            {docs.map((d) => (
              <option key={d.id} value={d.id} style={{ color: "#f8fafc", background: "#0b1220" }}>
                {pickDocTitle(d)}
              </option>
            ))}
          </select>

          <button
            type="submit"
            className="btn btn-ghost"
            disabled={!canMaterialize}
            style={{ opacity: canMaterialize ? 1 : 0.6 }}
          >
            {runningMaterialize ? "Materializing..." : "Materialize"}
          </button>
        </form>
      </div>

      {/* Step 2 */}
      <div className="card" style={{ marginBottom: 18 }}>
        <div style={{ fontWeight: 700, marginBottom: 10, color: "#f8fafc" }}>
          Step 2 — Execute (generate findings)
        </div>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontSize: 13, color: "rgba(248,250,252,.78)" }}>Choose tier:</div>

          <label style={{ display: "inline-flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
            <input
              type="radio"
              name="tier"
              value="basic"
              checked={tierChoice === "basic"}
              onChange={() => setTierChoice("basic")}
            />
            <span style={{ color: "#f8fafc" }}>$50 Basic (no PDF)</span>
          </label>

          <label style={{ display: "inline-flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
            <input
              type="radio"
              name="tier"
              value="pro"
              checked={tierChoice === "pro"}
              onChange={() => setTierChoice("pro")}
            />
            <span style={{ color: "#f8fafc" }}>$100 Pro (PDF export)</span>
          </label>
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button
            onClick={onExecute}
            className="btn btn-primary"
            disabled={!canExecute}
            style={{ opacity: canExecute ? 1 : 0.6 }}
            type="button"
          >
            {runningExecute ? "Executing..." : "Execute audit"}
          </button>

          <button onClick={onRefresh} className="btn btn-ghost" type="button">
            Refresh
          </button>
        </div>

        <div style={{ marginTop: 10, color: "rgba(248,250,252,.78)", fontSize: 13 }}>
          If you are redirected to Stripe, complete checkout and return here. The webhook will mark the analysis paid.
        </div>
      </div>

      {err ? <div style={{ marginBottom: 14, color: "#fca5a5", whiteSpace: "pre-wrap" }}>{err}</div> : null}
      {info ? <div style={{ marginBottom: 14, color: "rgba(248,250,252,.85)" }}>{info}</div> : null}

      {!analysisPayload ? (
        <div style={{ opacity: 0.75, color: "rgba(248,250,252,.78)" }}>
          No analysis loaded yet. Materialize a document above.
        </div>
      ) : (
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 13, color: "rgba(248,250,252,.78)" }}>Analysis ID</div>
              <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", color: "#f8fafc" }}>
                {shownAnalysisId || "—"}
              </div>
            </div>

            <div>
              <div style={{ fontSize: 13, color: "rgba(248,250,252,.78)" }}>Status</div>
              <div style={{ color: "#f8fafc" }}>{formatStatus(analysisRow)}</div>
            </div>

            <div>
              <div style={{ fontSize: 13, color: "rgba(248,250,252,.78)" }}>Target document</div>
              <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", color: "#f8fafc" }}>
                {analysisRow?.target_document_id || "—"}
              </div>
            </div>

            <div>
              <div style={{ fontSize: 13, color: "rgba(248,250,252,.78)" }}>Paid / Tier</div>
              <div style={{ color: "#f8fafc" }}>
                {paidDetected ? "paid" : "unpaid"} / {tierDetected || "—"}
              </div>
            </div>

            <div>
              <div style={{ fontSize: 13, color: "rgba(248,250,252,.78)" }}>PDF export</div>
              <div style={{ color: "#f8fafc" }}>{exportAllowed ? "allowed" : "disabled"}</div>
            </div>
          </div>

          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 13, color: "rgba(248,250,252,.78)" }}>Summary</div>
            <div style={{ marginTop: 4, color: "#f8fafc", whiteSpace: "pre-wrap" }}>
              {formatSummary(analysisRow)}
            </div>
          </div>

          <hr style={{ border: 0, borderTop: "1px solid rgba(255,255,255,.12)", margin: "16px 0" }} />

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <h2 style={{ fontSize: 16, margin: 0, color: "#f8fafc" }}>
              Findings {findings.length ? `(${findings.length})` : ""}
            </h2>

            <button
              type="button"
              className="btn btn-ghost"
              disabled={!exportAllowed}
              title={exportAllowed ? "Export audit as PDF" : "Upgrade to Pro ($100) to export PDF"}
              onClick={onExportPdf}
            >
              Export PDF
            </button>
          </div>

          {findings.length ? (
            <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
              {findings.map((f, idx) => {
                const title = clampStr(f?.title, 240) || "Finding";
                const severity = clampStr(f?.severity, 40) || "—";
                const claim = clampStr(f?.claim, 12000) || clampStr(f?.detail, 12000) || "—";
                const evidence = f?.evidence ?? null;

                return (
                  <div
                    key={clampStr(f?.id, 120) || `${idx}`}
                    style={{
                      border: "1px solid rgba(255,255,255,.12)",
                      borderRadius: 12,
                      padding: 12,
                      background: "rgba(0,0,0,.18)",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                      <div style={{ fontWeight: 700, color: "#f8fafc" }}>{title}</div>
                      <div style={{ fontSize: 12, color: "rgba(248,250,252,.75)" }}>{severity}</div>
                    </div>

                    <div style={{ marginTop: 6, color: "rgba(248,250,252,.90)", whiteSpace: "pre-wrap" }}>{claim}</div>

                    {evidence != null ? (
                      <details style={{ marginTop: 8 }}>
                        <summary style={{ cursor: "pointer", color: "rgba(248,250,252,.85)" }}>Evidence</summary>
                        <pre
                          style={{
                            marginTop: 8,
                            padding: 10,
                            borderRadius: 10,
                            border: "1px solid rgba(255,255,255,.12)",
                            overflowX: "auto",
                            whiteSpace: "pre-wrap",
                            color: "#f8fafc",
                            background: "rgba(0,0,0,.25)",
                          }}
                        >
                          {JSON.stringify(evidence, null, 2)}
                        </pre>
                      </details>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ marginTop: 10, color: "rgba(248,250,252,.78)" }}>No findings yet. If you just executed, click Refresh.</div>
          )}
        </div>
      )}
    </div>
  );
}
