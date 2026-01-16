// frontend/middleware.js
import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

/* ----------------------------- route groups ---------------------------- */

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
  // No auth at all
  return pathname === "/api/health" || pathname.startsWith("/api/auth/");
}

function isIngestPath(pathname) {
  // System secret ONLY
  return pathname.startsWith("/api/ingest/");
}

function isDualAuthApi(pathname) {
  // Allow either:
  //  - system secret (x-ingest-secret) for internal automation
  //  - user cookie auth for normal logged-in users
  if (pathname === "/api/search") return true;
  if (pathname === "/api/research") return true;
  if (pathname.startsWith("/api/resolve/")) return true;
  if (pathname.startsWith("/api/audit/run/materialize")) return true;
  if (pathname.startsWith("/api/documents/") && pathname.endsWith("/materialize")) return true;
  return false;
}

function isProtectedApi(pathname) {
  return (
    pathname.startsWith("/api/") &&
    !isPublicApi(pathname) &&
    !isIngestPath(pathname) &&
    !isDualAuthApi(pathname)
  );
}

function isProtectedApp(pathname) {
  return (
    pathname === "/app" ||
    pathname.startsWith("/app/") ||
    pathname === "/integrations" ||
    pathname.startsWith("/integrations/") ||
    pathname === "/settings" ||
    pathname.startsWith("/settings/")
  );
}

/* ------------------------------- helpers ------------------------------- */

function checkSystemSecret(req) {
  const provided = req.headers.get("x-ingest-secret") || "";
  const expected = process.env.INGEST_SECRET || "";
  if (!expected) return false;
  return provided === expected;
}

function isHardBypass(pathname) {
  // MUST be reachable without Supabase cookie auth
  return (
    pathname === "/api/purchase/token" ||
    pathname === "/api/stripe/webhook" ||
    pathname === "/api/debug/supabase" ||
    pathname === "/api/debug/analysis-exists" ||
    pathname === "/api/debug/entitlement"
  );
}

/* -------------------------------- middleware ------------------------------- */

export async function middleware(req) {
  const { pathname } = req.nextUrl;

  // Hard bypass (no auth)
  if (isHardBypass(pathname)) return NextResponse.next();

  // Always allow public paths and public APIs
  if (isPublicPath(pathname)) return NextResponse.next();
  if (isPublicApi(pathname)) return NextResponse.next();

  // Always allow preflight
  if (req.method === "OPTIONS") return NextResponse.next();

  // Ingest routes: system secret ONLY
  if (isIngestPath(pathname)) {
    if (!checkSystemSecret(req)) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.next();
  }

  // Dual-auth APIs: system secret OR user cookie
  if (isDualAuthApi(pathname)) {
    if (checkSystemSecret(req)) return NextResponse.next();
    // else fall through to user auth below
  }

  // If not protected, allow
  const needsAuth = isProtectedApi(pathname) || isProtectedApp(pathname) || isDualAuthApi(pathname);
  if (!needsAuth) return NextResponse.next();

  // Supabase session auth
  const res = NextResponse.next();

  const supabase = createServerClient(
    mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
    mustEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
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

  const { data } = await supabase.auth.getUser();

  if (!data?.user) {
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
