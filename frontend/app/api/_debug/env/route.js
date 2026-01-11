import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const anonLen = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").length;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const srvLen = serviceKey.length;

  const urlHost = supabaseUrl.replace(/^https?:\/\//, "").split("/")[0];

  if (!supabaseUrl || !serviceKey) {
    return Response.json(
      { ok: false, urlHost, anonLen, srvLen, error: "Missing env(s)" },
      { status: 500 }
    );
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
    global: { headers: { "x-application-name": "legal-research-organizer" } },
  });

  const { data, error } = await admin.from("source_jobs").select("id").limit(1);

  return Response.json({
    ok: !error,
    urlHost,
    anonLen,
    srvLen,
    probe: {
      data,
      error: error ? { message: error.message, code: error.code, details: error.details } : null,
    },
  });
}
