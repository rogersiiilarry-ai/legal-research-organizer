// frontend/app/api/documents/[id]/chunks/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

function json(status: number, payload: any) {
  return NextResponse.json(payload, { status });
}

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function asUuid(v: any): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return UUID_RE.test(s) ? s : null;
}

function asInt(v: any, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> | { id: string } }
) {
  try {
    // System auth: ingest-secret gate
    const provided = req.headers.get("x-ingest-secret") || "";
    const expected = process.env.INGEST_SECRET || "";
    if (!expected) return json(500, { ok: false, phase: "auth", error: "Missing INGEST_SECRET" });
    if (provided !== expected) return json(401, { ok: false, phase: "auth", error: "Unauthorized" });

    const supabaseUrl = mustEnv("NEXT_PUBLIC_SUPABASE_URL");
    const serviceKey = mustEnv("SUPABASE_SERVICE_ROLE_KEY");
    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    });

    const params = await ctx.params;
    const documentId = asUuid(params?.id);

    if (!documentId) {
      return json(400, { ok: false, phase: "input", error: "Invalid document id (UUID required)" });
    }

    const url = new URL(req.url);
    const limit = Math.max(1, Math.min(200, asInt(url.searchParams.get("limit"), 50)));
    const offset = Math.max(0, asInt(url.searchParams.get("offset"), 0));
    const maxChars = Math.max(200, Math.min(6000, asInt(url.searchParams.get("maxChars"), 1200)));

    // IMPORTANT:
    // If your chunks table column is not named `content`, change `content` below.
    const { data, error } = await supabase
      .from("chunks")
      .select("document_id, chunk_index, content, created_at")
      .eq("document_id", documentId)
      .order("chunk_index", { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) return json(500, { ok: false, phase: "db", error: error.message });

    const chunks =
      (data as any[])?.map((r) => ({
        document_id: r.document_id,
        chunk_index: r.chunk_index,
        // Trim payload for UI + safety; you can request full content later if needed
        content: String(r.content || "").slice(0, maxChars),
        created_at: r.created_at ?? null,
      })) ?? [];

    return json(200, {
      ok: true,
      mode: "system",
      document_id: documentId,
      count: chunks.length,
      limit,
      offset,
      maxChars,
      chunks,
    });
  } catch (e: any) {
    return json(500, { ok: false, phase: "exception", error: e?.message || String(e) });
  }
}
