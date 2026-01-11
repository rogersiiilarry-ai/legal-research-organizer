"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function LoginClient() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const router = useRouter();
  const sp = useSearchParams();

  async function onSubmit(e) {
    e.preventDefault();
    setErr("");
    setLoading(true);

    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ email, password }),
      });

      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || "Login failed");

      // redirect to REAL routes
      const next = (sp.get("next") || "/search").trim() || "/search";

      router.replace(next);
      router.refresh();
    } catch (e) {
      setErr(e?.message || "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ minHeight: "calc(100vh - 3.2rem)", padding: "2rem 1.4rem" }}>
      <div className="card" style={{ maxWidth: 520 }}>
        <h1 style={{ marginTop: 0 }}>Log in</h1>

        <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <label>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Email</div>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              required
              autoComplete="email"
            />
          </label>

          <label>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Password</div>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              required
              autoComplete="current-password"
            />
          </label>

          {err && <div style={{ color: "#fca5a5", fontSize: 13 }}>{err}</div>}

          <button type="submit" disabled={loading}>
            {loading ? "Logging in…" : "Log in"}
          </button>

          <a className="muted" href="/signup">Need an account? Sign up</a>
        </form>
      </div>
    </main>
  );
}
