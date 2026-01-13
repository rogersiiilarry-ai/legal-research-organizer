import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

function safeStr(v: any, max = 500) {
  if (typeof v !== "string") return "";
  const s = v.trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max) : s;
}

async function readJson(req: Request) {
  const raw = await req.text().catch(() => "");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function safeFilename(name: string) {
  const base = (name || "upload.pdf").trim() || "upload.pdf";
  const cleaned = base.replace(/[^\w.\-]+/g, "_");
  return cleaned.toLowerCase().endsWith(".pdf") ? cleaned : `${cleaned}.pdf`;
}

function isPdfContentType(ct: string) {
  const s = (ct || "").toLowerCase().trim();
  return s === "application/pdf" || s === "application/x-pdf";
}

type Auth =
  | { ok: true; userId: string }
  | { ok: false; status: number; error: string };

async function requireUser(): Promise<Auth> {
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
  if (error || !data?.user?.id) return { ok: false, status: 401, error: "Unauthorized" };

  return { ok: true, userId: data.user.id };
}

function storageAdmin() {
  return createClient(
    mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
    mustEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } }
  );
}

/**
 * POST JSON:
 *  { filename: string, contentType?: string, folder?: string }
 *
 * Returns:
 *  { bucket, path, uploadUrl, token, contentType }
 *
 * Client MUST upload using:
 *  fetch(uploadUrl, { method:"PUT", headers:{ "content-type": contentType, "x-upsert":"false", ...(token?{"Authorization":`Bearer ${token}`}:{}) }, body:file })
 *
 * Then store {bucket, path} into documents.raw.storage_bucket / raw.storage_path.
 */
export async function POST(req: Request) {
  try {
    const auth = await requireUser();
    if (!auth.ok) return json(auth.status, { ok: false, error: auth.error });

    const body = await readJson(req);

    const filename = safeFilename(safeStr(body?.filename, 200) || "upload.pdf");
    const contentType = safeStr(body?.contentType, 100) || "application/pdf";

    if (!isPdfContentType(contentType) && !filename.toLowerCase().endsWith(".pdf")) {
      return json(400, { ok: false, error: "Only PDF uploads are supported." });
    }

    const bucket = "documents";
    const folder = safeStr(body?.folder, 80) || "uploads";

    const nonce = crypto.randomBytes(12).toString("hex");
    const path = `${auth.userId}/${folder}/${Date.now()}_${nonce}_${filename}`;

    const admin = storageAdmin();

    // Preferred: signed upload URL
    // @ts-ignore typings differ by version
    const up = await admin.storage.from(bucket).createSignedUploadUrl(path);

    const signedUrl = up?.data?.signedUrl || up?.data?.signedURL || null;
    const token = up?.data?.token || null;

    if (up.error || !signedUrl) {
      return json(500, {
        ok: false,
        error: up.error?.message || "Failed to create signed upload URL.",
      });
    }

    return json(200, {
      ok: true,
      bucket,
      path,
      contentType: "application/pdf",
      uploadUrl: signedUrl,
      token, // may be required by your storage config
    });
  } catch (e: any) {
    return json(500, { ok: false, error: e?.message || String(e) });
  }
}