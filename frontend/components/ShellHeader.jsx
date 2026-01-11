"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { getBrowserSupabase } from "../lib/supabase/browserClient";

export default function ShellHeader() {
  const pathname = usePathname();
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const supabase = getBrowserSupabase();
    let alive = true;

    async function boot() {
      // Prefer session (fast + reliable), fallback to getUser
      const { data: s } = await supabase.auth.getSession();
      if (!alive) return;

      const sessionEmail = s?.session?.user?.email || "";
      setEmail(sessionEmail);

      if (!sessionEmail) {
        const { data: u } = await supabase.auth.getUser();
        if (!alive) return;
        setEmail(u?.user?.email || "");
      }

      setReady(true);
    }

    boot();

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!alive) return;
      setEmail(session?.user?.email || "");
    });

    return () => {
      alive = false;
      data?.subscription?.unsubscribe?.();
    };
  }, []);

  const signedIn = !!email;

  const nav = useMemo(() => {
    if (!signedIn) {
      return [
        { href: "/", label: "Home" },
        { href: "/login", label: "Login" },
        { href: "/signup", label: "Sign up" },
      ];
    }

    return [
      { href: "/app", label: "App" },
      { href: "/search", label: "Search" },
      { href: "/upload", label: "Upload" },
      { href: "/audit", label: "Audit" },
      { href: "/integrations", label: "Integrations" },
    ];
  }, [signedIn]);

  function isActive(href) {
    if (!pathname) return false;
    if (href === "/") return pathname === "/";
    return pathname === href || pathname.startsWith(href + "/");
  }

  async function onLogout() {
    const supabase = getBrowserSupabase();
    await supabase.auth.signOut();
    setEmail("");
    router.replace("/login");
    router.refresh();
  }

  return (
    <header
      style={{
        borderBottom: "1px solid rgba(148, 163, 184, 0.35)",
        padding: "0.75rem 1.25rem",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        background: "radial-gradient(circle at top left, #0f172a, #020617)",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
        <div
          style={{
            fontSize: 12,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            opacity: 0.75,
          }}
        >
          Endstorm · Legal Research Organizer
        </div>
        <div style={{ fontSize: 14, opacity: 0.95 }}>
          A research system that organizes legal records and highlights factual consistency,
          inconsistencies, and source coverage
        </div>
      </div>

      <nav style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        {nav.map((n) => {
          const active = isActive(n.href);

          return (
            <Link
              key={n.href}
              href={n.href}
              style={{
                textDecoration: "none",
                padding: "6px 10px",
                borderRadius: 999,
                border: "1px solid rgba(148, 163, 184, 0.35)",
                background: active ? "rgba(148, 163, 184, 0.12)" : "transparent",
                opacity: 0.95,
              }}
            >
              {n.label}
            </Link>
          );
        })}

        <span className="badge">
          {!ready ? "…" : email || "Not signed in"}
        </span>

        {signedIn ? (
          <button
            type="button"
            className="btn btn-ghost"
            style={{ padding: "8px 12px" }}
            onClick={onLogout}
          >
            Logout
          </button>
        ) : null}
      </nav>
    </header>
  );
}
