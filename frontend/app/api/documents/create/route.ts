// frontend/app/api/documents/create/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ------------------------------- helpers ------------------------------- */

function json(status: number, payload: any) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
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

function inferExternalSourceFromUrl(pdfUrl: string) {
  try {
    const u = new URL(pdfUrl);
    return (u.hostname || "").replace(/^www\./, "").trim() || "manual";
  } catch {
    return "manual";
  }
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

/* -------------------------------- route -------------------------------- */
/**
 * Accepts either:
 *  A) { pdf_url } for external docs
 *  B) { storage_path, storage_bucket? } for uploaded PDFs
 */
export async function POST(req: Request) {
  try {
    const auth = await requireUser();
    if (!auth.ok) return json(auth.status, { ok: false, error: auth.error });

    const body = await req.json().catch(() => ({} as any));

    const title = s(body?.title, 240) || null;
    const jurisdiction = s(body?.jurisdiction, 32) || "MI";

    // A) external URL
    const pdfUrl =
      s(body?.pdf_url, 2000) ||
      s(body?.pdfUrl, 2000) ||
      s(body?.url, 2000) ||
      "";

    // B) uploaded file storage pointer
    const storage_bucket = s(body?.storage_bucket, 128) || s(body?.storageBucket, 128) || "documents";
    const storage_path = s(body?.storage_path, 800) || s(body?.storagePath, 800) || "";

    if (!pdfUrl && !storage_path) {
      return json(400, { ok: false, error: "Provide either pdf_url OR storage_path" });
    }

    // external_source: prefer explicit, else infer
    const external_source =
      s(body?.external_source, 160) ||
      s(body?.externalSource, 160) ||
      (pdfUrl ? inferExternalSourceFromUrl(pdfUrl) : "upload");

    // deterministic external_id:
    // - for url docs: url:<sha1(pdfUrl)>
    // - for uploads: storage:<sha1(bucket/path)>
    const defaultExternalId = pdfUrl
      ? `url:${sha1(pdfUrl)}`
      : `storage:${sha1(`${storage_bucket}/${storage_path}`)}`;

    const external_id =
      s(body?.external_id, 240) ||
      s(body?.externalId, 240) ||
      defaultExternalId;

    const rawIn = body?.raw && typeof body.raw === "object" ? body.raw : {};

    // Build raw consistently so downstream code can resolve a pdf:
    // - url docs -> raw.pdf_url present
    // - uploads -> raw.storage_bucket + raw.storage_path present
    const raw: any = {
      ...rawIn,
      created_at_client: new Date().toISOString(),
    };

    if (pdfUrl) {
      raw.pdf_url = pdfUrl;
      raw.pdf = pdfUrl; // backwards compatibility for older code
    }

    if (storage_path) {
      raw.storage_bucket = storage_bucket;
      raw.storage_path = storage_path;
      raw.original_filename = s(body?.filename, 240) || raw.original_filename || null;
    }

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
        {
          // keep your existing unique constraint target
          onConflict: "external_source,external_id",
        }
      )
      .select("id")
      .single();

    if (error) return json(500, { ok: false, error: error.message });

    return json(200, {
      ok: true,
      documentId: data.id,
      external_source,
      external_id,
      has_pdf_url: !!pdfUrl,
      has_storage: !!storage_path,
    });
  } catch (e: any) {
    return json(500, { ok: false, error: e?.message || String(e) });
  }
}