// frontend/app/api/upload/pdf/route.ts
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

async function trySignedDownloadUrl(admin: any, bucket: string, path: string) {
  // 1 hour signed download
  const r = await admin.storage.from(bucket).createSignedUrl(path, 60 * 60);
  if (r?.data?.signedUrl) return r.data.signedUrl as string;
  return null;
}

export async function POST(req: Request) {
  try {
    const auth = await requireUser();
    if (!auth.ok) return json(auth.status, { ok: false, error: auth.error });

    const contentType = (req.headers.get("content-type") || "").toLowerCase();

    // We support BOTH:
    //  - multipart/form-data (UI uploads file bytes)
    //  - application/json (advanced callers)
    const bucket = "documents";
    const folderDefault = "uploads";

    let filename = "upload.pdf";
    let folder = folderDefault;
    let fileBytes: ArrayBuffer | null = null;
    let fileCt = "application/pdf";

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");

      if (!(file instanceof File)) {
        return json(400, { ok: false, error: "Missing form field: file" });
      }

      filename = safeFilename(file.name || "upload.pdf");
      fileCt = safeStr(file.type, 120) || "application/pdf";
      folder = safeStr(form.get("folder"), 80) || folderDefault;

      if (!isPdfContentType(fileCt) && !filename.toLowerCase().endsWith(".pdf")) {
        return json(400, { ok: false, error: "Only PDF uploads are supported." });
      }

      // guard (25 MB)
      const maxBytes = 25 * 1024 * 1024;
      if (typeof file.size === "number" && file.size > maxBytes) {
        return json(413, { ok: false, error: "File too large. Max 25MB." });
      }

      fileBytes = await file.arrayBuffer();
    } else {
      // JSON mode: { filename, contentType, folder, bytesBase64? }
      const raw = await req.text().catch(() => "");
      let body: any = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = {};
      }

      filename = safeFilename(safeStr(body?.filename, 200) || "upload.pdf");
      fileCt = safeStr(body?.contentType, 120) || "application/pdf";
      folder = safeStr(body?.folder, 80) || folderDefault;

      // In JSON mode, we require bytesBase64 if you actually want upload.
      // Otherwise, return a clear error so callers don’t think it uploaded.
      const bytesBase64 = safeStr(body?.bytesBase64, 1_000_000_000);
      if (!bytesBase64) {
        return json(400, {
          ok: false,
          error:
            "JSON mode requires bytesBase64. Prefer multipart/form-data with form field 'file' from the UI.",
        });
      }

      const buf = Buffer.from(bytesBase64, "base64");
      fileBytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }

    if (!fileBytes) {
      return json(400, { ok: false, error: "No file bytes received." });
    }

    const nonce = crypto.randomBytes(12).toString("hex");
    const path = `${auth.userId}/${folder}/${Date.now()}_${nonce}_${filename}`;

    const admin = storageAdmin();

    // Upload bytes to Storage
    const uploadRes = await admin.storage.from(bucket).upload(path, fileBytes, {
      contentType: "application/pdf",
      upsert: false,
    });

    if (uploadRes.error) {
      return json(500, { ok: false, error: uploadRes.error.message });
    }

    // Prefer signed download URL (works for private buckets)
    const signed = await trySignedDownloadUrl(admin, bucket, path);

    // If bucket is public, you could use getPublicUrl; it will still return something even if not public.
    const pub = admin.storage.from(bucket).getPublicUrl(path);
    const publicUrl = pub?.data?.publicUrl || null;

    const bestUrl = signed || publicUrl;

    if (!bestUrl) {
      return json(500, { ok: false, error: "Upload succeeded but no URL could be generated." });
    }

    // Return ALL common field names so any client variant works.
    return json(200, {
      ok: true,
      bucket,
      path,
      contentType: "application/pdf",

      // canonical (what your UI expects)
      url: bestUrl,

      // compatibility
      signedUrl: signed,
      publicUrl,
      uploadUrl: bestUrl,
      upload_url: bestUrl,
    });
  } catch (e: any) {
    return json(500, { ok: false, error: e?.message || String(e) });
  }
}
