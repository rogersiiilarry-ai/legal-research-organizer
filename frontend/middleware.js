import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

function isPublicPath(pathname) {
  return (
    pathname === "/" ||
    pathname === "/login" ||
    pathname === "/signup" ||
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico"
  );
}

function isPublicApi(pathname) {
  return pathname === "/api/health" || pathname.startsWith("/api/auth/");
}

function isIngestPath(pathname) {
  return pathname.startsWith("/api/ingest/");
}

function isProtectedApi(pathname) {
  // everything under /api is protected except health + api/auth/*
  return pathname.startsWith("/api/") && !isPublicApi(pathname) && !isIngestPath(pathname);
}

function isProtectedApp(pathname) {
  return (
    pathname === "/app" || pathname.startsWith("/app/") ||
    pathname === "/integrations" || pathname.startsWith("/integrations/") ||
    pathname === "/settings" || pathname.startsWith("/settings/")
  );
}

export async function middleware(req) {
  const { pathname } = req.nextUrl;

  // Always allow public static/app routes
  if (isPublicPath(pathname)) return NextResponse.next();

  // Public API routes (no auth)
  if (isPublicApi(pathname)) return NextResponse.next();

  // Always allow preflight
  if (req.method === "OPTIONS") return NextResponse.next();

  // Ingest routes: header-based auth only (no cookie session required)
  if (isIngestPath(pathname)) {
    const provided = req.headers.get("x-ingest-secret") || "";
    const expected = process.env.INGEST_SECRET || "";
    if (!expected || provided !== expected) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.next();
  }

  // Only protect these app paths and all other /api/*
  if (!isProtectedApp(pathname) && !isProtectedApi(pathname)) {
    return NextResponse.next();
  }

  // Supabase session check
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
          res.cookies.set({ name, value: "", ...options });
        },
      },
    }
  );

  const { data } = await supabase.auth.getUser();
  if (!data?.user) {
    // For API routes, return 401 JSON. For app routes, redirect to /login.
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
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
