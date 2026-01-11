import { getAnonSupabase } from "./serverClients";

export async function requireUserFromRequest(req) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : null;
  if (!token) return { user: null };

  const supabase = getAnonSupabase();
  const { data, error } = await supabase.auth.getUser(token);
  if (error) return { user: null };
  return { user: data.user || null };
}