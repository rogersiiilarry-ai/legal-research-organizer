import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

export const runtime = "nodejs";

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

export async function GET() {
  const cookieStore = cookies();

  const supabase = createServerClient(
    mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
    mustEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        set() {},
        remove() {},
      },
    }
  );

  const { data, error } = await supabase.auth.getUser();

  return NextResponse.json({
    ok: !error && !!data?.user,
    error: error?.message || null,
    user: data?.user ? { id: data.user.id, email: data.user.email } : null,
    cookieNames: cookieStore.getAll().map((c) => c.name),
  });
}
