"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { getBrowserSupabase } from "../../lib/supabase/browserClient";

export default function SignUp() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const router = useRouter();

  async function onSubmit(e) {
    e.preventDefault();
    setErr("");
    setOk("");
    const supabase = getBrowserSupabase();
    const { error } = await supabase.auth.signUp({ email, password });
    if (error) return setErr(error.message);
    setOk("Account created. You can now log in.");
    setTimeout(() => router.push("/login"), 700);
  }

  return (
    <main style={{ minHeight: "calc(100vh - 3.2rem)", padding: "2rem 1.4rem" }}>
      <div className="card" style={{ maxWidth: 520 }}>
        <h1 style={{ marginTop: 0 }}>Sign up</h1>
        <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <label>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Email</div>
            <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required
              style={{ width: "100%", padding: 10, borderRadius: 10, border: "1px solid rgba(148,163,184,0.35)", background: "rgba(2,6,23,0.6)", color: "#e5e7eb" }} />
          </label>
          <label>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Password</div>
            <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" required minLength={6}
              style={{ width: "100%", padding: 10, borderRadius: 10, border: "1px solid rgba(148,163,184,0.35)", background: "rgba(2,6,23,0.6)", color: "#e5e7eb" }} />
          </label>

          {err ? <div style={{ color: "#fca5a5", fontSize: 13 }}>{err}</div> : null}
          {ok ? <div style={{ color: "#86efac", fontSize: 13 }}>{ok}</div> : null}

          <button className="btn btn-primary" type="submit">Create account</button>
          <a className="muted" href="/login">Already have an account? Log in</a>
        </form>
      </div>
    </main>
  );
}