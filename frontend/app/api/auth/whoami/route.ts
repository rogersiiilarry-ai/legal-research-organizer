// frontend/app/api/auth/whoami/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { CookieOptions } from "@supabase/ssr";

export const runtime = "nodejs";

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function json(status: number, payload: any) {
  return NextResponse.json(payload, { status });
}

export async function GET() {
  try {
    const cookieStore = cookies();

    const supabase = createServerClient(
      mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
      mustEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
      {
        cookies: {
          get(name: string) {
            return cookieStore.get(name)?.value;
          },
          // whoami is read-only; keep as no-ops but typed
          set(_name: string, _value: string, _options: CookieOptions) {},
          remove(_name: string, _options: CookieOptions) {},
        },
      }
    );

    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) {
      return json(401, { ok: false, error: "Unauthorized" });
    }

    return json(200, {
      ok: true,
      user: {
        id: data.user.id,
        email: data.user.email,
      },
    });
  } catch (e: any) {
    return json(500, { ok: false, error: e?.message || String(e) });
  }
}
