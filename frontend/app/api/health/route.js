// frontend/app/api/health/route.js
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // critical: ensure a lambda is generated

export async function GET() {
  return NextResponse.json(
    { ok: true, ts: new Date().toISOString() },
    { status: 200 }
  );
}
