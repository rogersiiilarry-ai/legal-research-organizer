// frontend/app/api/auth/login/route.ts
import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import type { CookieOptions } from "@supabase/ssr";

export const runtime = "nodejs";

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

async function readJson(req: Request): Promise<any> {
  try {
    const buf = await req.arrayBuffer();
    const raw = Buffer.from(buf).toString("utf8").trim();
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  } catch {
    return {};
  }
}

export async function POST(req: Request) {
  const res = NextResponse.json({ ok: false }, { status: 500 });

  try {
    const body = await readJson(req);
    const email = typeof body?.email === "string" ? body.email.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";

    if (!email || !password) {
      return NextResponse.json({ ok: false, error: "Missing email/password" }, { status: 400 });
    }

    // IMPORTANT: for login you want cookie WRITE support, so we use the "req+res" style adapter.
    const supabase = createServerClient(
      mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
      mustEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
      {
        cookies: {
          get(name: string) {
            return req.headers.get("cookie")?.match(new RegExp(`(?:^|; )${name}=([^;]*)`))?.[1];
          },
          set(name: string, value: string, options: CookieOptions) {
            // NextResponse cookie writer
            res.cookies.set({ name, value, ...options });
          },
          remove(name: string, options: CookieOptions) {
            res.cookies.set({ name, value: "", ...options, maxAge: 0 });
          },
        },
      }
    );

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error || !data?.session) {
      return NextResponse.json({ ok: false, error: error?.message || "Login failed" }, { status: 401 });
    }

    // Return the same response object we wrote cookies onto
    return NextResponse.json(
      { ok: true, user: { id: data.user?.id, email: data.user?.email } },
      { status: 200, headers: res.headers }
    );
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
