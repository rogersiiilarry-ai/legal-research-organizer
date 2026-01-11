// frontend/middleware.js
import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

function getSupabase(req) {
  const res = NextResponse.next();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        get(name) {
          return req.cookies.get(name)?.value;
        },
        set(name, value, options) {
          res.cookies.set({ name, value, ...options });
        },
        remove(name, options) {
          res.cookies.set({ name, value: "", ...options, maxAge: 0 });
        },
      },
    }
  );

  return { supabase, res };
}

export async function middleware(req) {
  const { pathname } = req.nextUrl;

  // Always allow preflight
  if (req.method === "OPTIONS") return NextResponse.next();

  // Always allow Next internals + common static
  if (
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico" ||
    pathname === "/robots.txt" ||
    pathname === "/sitemap.xml" ||
    pathname === "/manifest.json"
  ) {
    return NextResponse.next();
  }

  // Public pages
  const publicPaths = ["/", "/login", "/signup"];
  if (publicPaths.includes(pathname)) return NextResponse.next();

  // ------------------------------------------------------------
  // PUBLIC AUTH PATHS (must be accessible before login)
  // ------------------------------------------------------------
  // Supabase can use /auth/v1/* and you may have /api/auth/*
  // Also allow auth callbacks if you route them through /auth/*
  if (
    pathname.startsWith("/auth/") ||          // supabase hosted/auth callback paths
    pathname.startsWith("/api/auth/")        // your next api auth routes (if any)
  ) {
    return NextResponse.next();
  }

  // ------------------------------------------------------------
  // ADMIN ROUTES (header-based auth; no cookie session required)
  // ------------------------------------------------------------
  if (pathname.startsWith("/api/admin/")) {
    const provided = req.headers.get("x-admin-secret") || "";
    const expected = process.env.ADMIN_SECRET || "";

    if (!expected) {
      return NextResponse.json(
        { ok: false, error: "Server misconfigured: ADMIN_SECRET is not set" },
        { status: 500 }
      );
    }

    if (provided !== expected) {
      return NextResponse.json({ ok: false, error: "Unauthorized (admin)" }, { status: 401 });
    }

    return NextResponse.next();
  }

  // ------------------------------------------------------------
  // INGEST ROUTES (header-based auth; no cookie session required)
  // ------------------------------------------------------------
  if (pathname.startsWith("/api/ingest/")) {
    const provided = req.headers.get("x-ingest-secret") || "";
    const expected = process.env.INGEST_SECRET || "";

    if (expected && provided === expected) return NextResponse.next();

    return NextResponse.json({ ok: false, error: "Unauthorized (ingest)" }, { status: 401 });
  }

  // ------------------------------------------------------------
  // Everything else under /api requires a logged-in user session
  // ------------------------------------------------------------
  if (pathname.startsWith("/api/")) {
    const { supabase, res } = getSupabase(req);
    const { data } = await supabase.auth.getUser();

    if (!data?.user) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    return res;
  }

  // ------------------------------------------------------------
  // Pages: require logged-in session
  // ------------------------------------------------------------
  const { supabase, res } = getSupabase(req);
  const { data } = await supabase.auth.getUser();

  if (!data?.user) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
