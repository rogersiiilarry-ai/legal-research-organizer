"use client";

import { useEffect, useMemo, useState } from "react";

function s(v: any) {
  return typeof v === "string" ? v.trim() : "";
}

export default function AuditClient() {
  const [documentToken, setDocumentToken] = useState("");
  const [tier, setTier] = useState<"basic" | "pro">("pro");
  const [msg, setMsg] = useState<string>("");

  const withPdf = tier === "pro";
  const canGo = useMemo(() => Boolean(s(documentToken)), [documentToken]);

  useEffect(() => {
    const u = new URL(window.location.href);
    const checkout = u.searchParams.get("checkout");
    if (checkout === "success") setMsg("Payment successful. Click Materialize again.");
    if (checkout === "cancel") setMsg("Checkout canceled.");
  }, []);

  function onMaterialize() {
    const doc = s(documentToken);
    if (!doc) return;

    const qs = new URLSearchParams({
      mode: "materialize-and-run",
      document_id: doc,
      withPdf: withPdf ? "1" : "0",
    });

    window.location.href = `/api/audit/run?${qs.toString()}`;
  }

  return (
    <div style={{ maxWidth: 800, margin: "40px auto", padding: 20 }}>
      <h1>Audit</h1>

      <input
        style={{ width: "100%", padding: 10, marginTop: 12 }}
        placeholder="Document ID or external id"
        value={documentToken}
        onChange={(e) => setDocumentToken(e.target.value)}
      />

      <div style={{ marginTop: 12 }}>
        <label>
          <input type="radio" checked={tier === "basic"} onChange={() => setTier("basic")} />
          {" "}Basic
        </label>

        <label style={{ marginLeft: 16 }}>
          <input type="radio" checked={tier === "pro"} onChange={() => setTier("pro")} />
          {" "}Pro
        </label>
      </div>

      <button style={{ marginTop: 16 }} onClick={onMaterialize} disabled={!canGo}>
        Materialize
      </button>

      {msg ? <div style={{ marginTop: 12 }}>{msg}</div> : null}
    </div>
  );
}
