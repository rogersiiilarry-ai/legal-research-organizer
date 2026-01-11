import { getServiceSupabase } from "../../../../../lib/supabase/serverClients";

export async function POST(req, { params }) {
  const name = params.name;
  const payloadText = await req.text();

  // Safe stub: verify signatures, store events, enqueue jobs.
  // Example storage can be implemented by creating an events table.
  const supabase = getServiceSupabase();
  void supabase;

  return new Response(JSON.stringify({ ok: true, webhook: name, received: true, length: payloadText.length }), {
    headers: { "Content-Type": "application/json" }
  });
}