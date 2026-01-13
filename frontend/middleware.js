import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

/* ----------------------------- path helpers ----------------------------- */

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
  return pathname.startsWith("/api/ingest/");
}

function isSystemAllowedApi(pathname) {
  // Internal system calls authenticated via x-ingest-secret
  return pathname === "/api/search" || pathname.startsWith("/api/resolve") || pathname.startsWith("/api/audit/run/materialize") || (pathname.startsWith("/api/documents/") && pathname.endsWith("/materialize"));}

function isProtectedApi(pathname) {
  // Everything under /api except explicit exclusions
  return (
    pathname.startsWith("/api/") &&
    !isPublicApi(pathname) &&
    !isIngestPath(pathname) &&
    !isSystemAllowedApi(pathname)
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

/* ------------------------------- middleware ------------------------------ */

export async function middleware(req) {
  const { pathname } = req.nextUrl;

  // Always allow public paths
  if (isPublicPath(pathname)) return NextResponse.next();

  // Public APIs
  if (isPublicApi(pathname)) return NextResponse.next();

  // Always allow preflight
  if (req.method === "OPTIONS") return NextResponse.next();

  // Ingest routes: header-based auth only
  if (isIngestPath(pathname)) {
    const provided = req.headers.get("x-ingest-secret") || "";
    const expected = process.env.INGEST_SECRET || "";

    if (!expected || provided !== expected) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.next();
  }

  // System-allowed APIs: also header-based auth
  if (isSystemAllowedApi(pathname)) {
    const provided = req.headers.get("x-ingest-secret") || "";
    const expected = process.env.INGEST_SECRET || "";

    if (!expected || provided !== expected) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.next();
  }

  // If not protected, allow
  if (!isProtectedApi(pathname) && !isProtectedApp(pathname)) {
    return NextResponse.next();
  }

  // Supabase session auth
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

