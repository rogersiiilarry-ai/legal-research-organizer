import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function s(v: any) {
  return typeof v === "string" ? v.trim() : "";
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const analysisId = s(body?.analysisId || body?.analysis_id);

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

  const { data: u } = await supabase.auth.getUser();
  const userId = u?.user?.id || null;

  // profile flags (RLS must allow user to read own profile)
  const prof = userId
    ? await supabase.from("profiles").select("id,is_admin,free_access,free_tier").eq("id", userId).maybeSingle()
    : { data: null, error: null };

  // analysis meta (RLS might block; this is still useful as a signal)
  const an = analysisId
    ? await supabase.from("analyses").select("id,meta,owner_id").eq("id", analysisId).maybeSingle()
    : { data: null, error: null };

  return NextResponse.json({
    ok: true,
    analysisId,
    userId,
    profile: { data: prof.data || null, error: prof.error?.message || null },
    analysis: { data: an.data || null, error: an.error?.message || null },
  });
}
