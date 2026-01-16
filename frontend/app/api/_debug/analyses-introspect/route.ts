import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

export async function GET() {
  const admin = createClient(
    mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
    mustEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } }
  );

  // Find all relations named 'analyses' across schemas
  const { data: rels, error: relErr } = await admin.rpc("sql", {
    // if you don't have a sql RPC, we'll switch to another method
    query: `
      select table_schema, table_name, table_type
      from information_schema.tables
      where table_name = 'analyses'
      order by table_schema;
    `,
  });

  if (relErr) {
    return NextResponse.json({
      ok: false,
      error: relErr.message,
      hint:
        "No sql RPC found. We'll introspect another way (tell me this error).",
    }, { status: 500 });
  }

  return NextResponse.json({ ok: true, rels });
}
