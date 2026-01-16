import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const analysisId = String(body?.analysisId || body?.analysis_id || "").trim();

  if (!analysisId) {
    return NextResponse.json({ ok: false, error: "analysisId required" }, { status: 400 });
  }

  const admin = createClient(
    mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
    mustEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } }
  );

  const q1 = await admin.from("analyses").select("id").eq("id", analysisId).maybeSingle();
  const q2 = await admin.from("analyses").select("id").eq("analysis_id", analysisId).maybeSingle();

  return NextResponse.json({
    ok: true,
    analysisId,
    by_id: { data: q1.data || null, error: q1.error?.message || null },
    by_analysis_id: { data: q2.data || null, error: q2.error?.message || null },
  });
}
