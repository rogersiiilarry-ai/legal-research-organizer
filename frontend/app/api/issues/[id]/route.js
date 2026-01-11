import { getServiceSupabase } from "../../../../lib/supabase/serverClients";
import { requireUserFromRequest } from "../../../../lib/supabase/auth";

export async function GET(req, { params }) {
  const supabase = getServiceSupabase();
  const { user } = await requireUserFromRequest(req);
  if (!user?.id) {
    return new Response(JSON.stringify({ ok: false, error: "Missing bearer token" }), { status: 401 });
  }

  const { data, error } = await supabase
    .from("issues")
    .select("*")
    .eq("id", params.id)
    .eq("owner_id", user.id)
    .single();

  if (error) return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 404 });
  return new Response(JSON.stringify({ ok: true, data }), { headers: { "Content-Type": "application/json" } });
}

export async function PATCH(req, { params }) {
  const supabase = getServiceSupabase();
  const { user } = await requireUserFromRequest(req);
  if (!user?.id) {
    return new Response(JSON.stringify({ ok: false, error: "Missing bearer token" }), { status: 401 });
  }

  const body = await req.json().catch(() => ({}));

  const { data, error } = await supabase
    .from("issues")
    .update(body)
    .eq("id", params.id)
    .eq("owner_id", user.id)
    .select("*")
    .single();

  if (error) return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 400 });
  return new Response(JSON.stringify({ ok: true, data }), { headers: { "Content-Type": "application/json" } });
}

export async function DELETE(req, { params }) {
  const supabase = getServiceSupabase();
  const { user } = await requireUserFromRequest(req);
  if (!user?.id) {
    return new Response(JSON.stringify({ ok: false, error: "Missing bearer token" }), { status: 401 });
  }

  const { error } = await supabase
    .from("issues")
    .delete()
    .eq("id", params.id)
    .eq("owner_id", user.id);

  if (error) return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 400 });
  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
}