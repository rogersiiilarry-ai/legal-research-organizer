"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@supabase/supabase-js";

function s(v: any) {
  return typeof v === "string" ? v.trim() : "";
}

function mustEnv(name: string) {
  const v = (process.env as any)[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v as string;
}

export default function AuditClient() {
  const [documentToken, setDocumentToken] = useState("");
  const [tier, setTier] = useState<"basic" | "pro">("pro");
  const [msg, setMsg] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const withPdf = tier === "pro";
  const canGo = useMemo(() => Boolean(s(documentToken)) && !busy, [documentToken, busy]);

  useEffect(() => {
    const u = new URL(window.location.href);
    const checkout = u.searchParams.get("checkout");
    if (checkout === "success") setMsg("Payment successful. Click Materialize again.");
    if (checkout === "cancel") setMsg("Checkout canceled.");
  }, []);

  async function onMaterialize() {
    const doc = s(documentToken);
    if (!doc || busy) return;

    setBusy(true);
    setMsg("");

    try {
      // Create a browser Supabase client (reads local session)
      const supabase = createClient(
        mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
        mustEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY")
      );

      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;

      if (!token) {
        window.location.href = "/login";
        return;
      }

      const res = await fetch("/api/audit/run/materialize-and-run", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          document_id: doc,
          withPdf,
        }),
      });

      const payload = await res.json().catch(() => ({} as any));

      // Not logged in / token rejected
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }

      // Paywall => redirect to Stripe
      if (res.status === 402 && payload?.checkout_url) {
        window.location.href = payload.checkout_url;
        return;
      }

      // Other errors
      if (!res.ok || payload?.ok === false) {
        setMsg(payload?.error || `Request failed (${res.status})`);
        return;
      }

      // Success
      setMsg(`Done. Analysis: ${payload?.analysisId || "(unknown)"}`);
    } catch (e: any) {
      setMsg(e?.message || String(e));
    } finally {
      setBusy(false);
    }
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
        {busy ? "Working..." : "Materialize"}
      </button>

      {msg ? <div style={{ marginTop: 12 }}>{msg}</div> : null}
    </div>
  );
}
