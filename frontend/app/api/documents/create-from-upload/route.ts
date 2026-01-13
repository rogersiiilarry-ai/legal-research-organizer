import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(status: number, payload: any) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "no-store" } });
}

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function s(v: any, max = 2000) {
  if (typeof v !== "string") return "";
  const t = v.trim();
  if (!t) return "";
  return t.length > max ? t.slice(0, max) : t;
}

function sha1(input: string) {
  return crypto.createHash("sha1").update(input).digest("hex");
}

async function requireUser() {
  const cookieStore = cookies();
  const supabaseAuth = createServerClient(
    mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
    mustEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        set() {},
        remove() {},
      },
    }
  );

  const { data, error } = await supabaseAuth.auth.getUser();
  if (error || !data?.user?.id) return { ok: false as const, status: 401, error: "Unauthorized" };
  return { ok: true as const, userId: data.user.id };
}

export async function POST(req: Request) {
  try {
    const auth = await requireUser();
    if (!auth.ok) return json(auth.status, { ok: false, error: auth.error });

    const body = await req.json().catch(() => ({} as any));

    const bucket = s(body?.bucket, 120) || "documents";
    const path = s(body?.path, 2000);
    if (!path) return json(400, { ok: false, error: "path is required" });

    const title = s(body?.title, 240) || null;
    const jurisdiction = s(body?.jurisdiction, 32) || "MI";

    // Deterministic external_id for storage object
    const external_source = "supabase-storage";
    const external_id = s(body?.external_id, 240) || `storage:${sha1(`${bucket}:${path}`)}`;

    const rawIn = body?.raw && typeof body.raw === "object" ? body.raw : {};
    const raw = {
      ...rawIn,
      storage_bucket: bucket,
      storage_path: path,
      created_at_client: new Date().toISOString(),
    };

    const admin = createClient(
      mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
      mustEnv("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false } }
    );

    const { data, error } = await admin
      .from("documents")
      .upsert(
        {
          owner_id: auth.userId,
          title,
          jurisdiction,
          external_source,
          external_id,
          raw,
        },
        { onConflict: "external_source,external_id" }
      )
      .select("id")
      .single();

    if (error) return json(500, { ok: false, error: error.message });

    return json(200, { ok: true, documentId: data.id });
  } catch (e: any) {
    return json(500, { ok: false, error: e?.message || String(e) });
  }
}