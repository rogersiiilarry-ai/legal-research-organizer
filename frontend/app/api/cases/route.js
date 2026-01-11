import { getServiceSupabase } from "../../../lib/supabase/serverClients";
import { requireUserFromRequest } from "../../../lib/supabase/auth";

export async function GET(req) {
  const supabase = getServiceSupabase();
  const { user } = await requireUserFromRequest(req);
  if (!user?.id) {
    return new Response(JSON.stringify({ ok: false, error: "Missing bearer token" }), { status: 401 });
  }

  const { data, error } = await supabase
    .from("cases")
    .select("*")
    .eq("owner_id", user.id)
    .order("created_at", { ascending: false });

  if (error) return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 400 });
  return new Response(JSON.stringify({ ok: true, data }), { headers: { "Content-Type": "application/json" } });
}

export async function POST(req) {
  const supabase = getServiceSupabase();
  const { user } = await requireUserFromRequest(req);
  if (!user?.id) {
    return new Response(JSON.stringify({ ok: false, error: "Missing bearer token" }), { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const row = { ...body, owner_id: user.id };

  const { data, error } = await supabase.from("cases").insert(row).select("*").single();
  if (error) return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 400 });
  return new Response(JSON.stringify({ ok: true, data }), { headers: { "Content-Type": "application/json" } });
}