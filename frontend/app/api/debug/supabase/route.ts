import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    ok: true,
    supabase_url: process.env.NEXT_PUBLIC_SUPABASE_URL || null,
    has_service_role: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    has_anon: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
}
