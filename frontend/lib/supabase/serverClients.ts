// frontend/lib/supabase/serverClients.ts
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import type { CookieOptions } from "@supabase/ssr";

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

/**
 * Cookie-bound Supabase client (for auth + user session in Route Handlers / Server Components).
 * IMPORTANT: This adapter is intentionally "read-only" for cookies in Route Handlers, because
 * Next route handlers cannot reliably set cookies the same way middleware can.
 */
export function getUserSupabase() {
  const cookieStore = cookies();

  return createServerClient(
    mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
    mustEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        // Read-only no-ops are acceptable for most API routes that only need to read the session.
        set(_name: string, _value: string, _options: CookieOptions) {},
        remove(_name: string, _options: CookieOptions) {},
      },
    }
  );
}

/** Service-role Supabase client for privileged DB operations (never expose to browser). */
export function getServiceSupabase() {
  return createClient(
    mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
    mustEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } }
  );
}

/** Optional back-compat helper if older code still imports it. */
export function getAnonSupabase() {
  return createClient(
    mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
    mustEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    { auth: { persistSession: false } }
  );
}
