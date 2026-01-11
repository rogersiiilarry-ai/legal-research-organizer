"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getBrowserSupabase } from "@/lib/supabase/browserClient";

export default function Logout() {
  const router = useRouter();
  useEffect(() => {
    const supabase = getBrowserSupabase();
    supabase.auth.signOut().finally(() => router.push("/"));
  }, [router]);

  return (
    <main style={{ minHeight: "calc(100vh - 3.2rem)", padding: "2rem 1.4rem" }}>
      <div className="card" style={{ maxWidth: 520 }}>
        <h1 style={{ marginTop: 0 }}>Signing out…</h1>
        <p className="muted" style={{ marginBottom: 0 }}>You will be redirected to home.</p>
      </div>
    </main>
  );
}