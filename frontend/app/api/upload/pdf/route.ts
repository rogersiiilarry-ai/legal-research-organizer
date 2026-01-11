// frontend/app/api/upload/pdf/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ------------------------------- helpers ------------------------------- */

function json(status: number, payload: any) {
  return NextResponse.json(payload, { status });
}

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function safeFilename(name: string) {
  const base = (name || "upload.pdf").trim() || "upload.pdf";
  // keep it filesystem + url safe
  return base.replace(/[^\w.\-]+/g, "_");
}

function isPdfNameOrMime(name: string, mime: string) {
  const lower = (name || "").toLowerCase();
  if (mime === "application/pdf") return true;
  if (lower.endsWith(".pdf")) return true;
  return false;
}

/* -------------------------------- auth -------------------------------- */

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
        // Route handlers can't reliably mutate cookies; no-ops are correct here.
        set() {},
        remove() {},
      },
    }
  );

  const { data, error } = await supabaseAuth.auth.getUser();

  if (error || !data?.user?.id) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  return { ok: true, userId: data.user.id };
}

/* -------------------------------- CORS -------------------------------- */
/**
 * Optional, but harmless. If you ever hit this route cross-origin, preflight won't 405.
 * For same-origin (normal Next.js app), it doesn't matter.
 */
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    },
  });
}

/* -------------------------------- route -------------------------------- */

export async function POST(req: Request) {
  try {
    const auth = await requireUser();
    if (auth.ok === false) return json(auth.status, { ok: false, error: auth.error });

    const ct = req.headers.get("content-type") || "";
    if (!ct.toLowerCase().includes("multipart/form-data")) {
      return json(415, {
        ok: false,
        error: "Unsupported Content-Type. Expected multipart/form-data with field 'file'.",
      });
    }

    const form = await req.formData();
    const file = form.get("file");

    if (!(file instanceof File)) {
      return json(400, { ok: false, error: "Expected multipart form-data with field 'file'." });
    }

    const name = safeFilename(file.name);
    const mime = String(file.type || "");

    if (!isPdfNameOrMime(name, mime)) {
      return json(400, { ok: false, error: "Only PDF files are allowed." });
    }

    // Read bytes (Uint8Array avoids TS BodyInit issues and is compatible with supabase-js)
    const ab = await file.arrayBuffer();
    const bytes = new Uint8Array(ab);

    // Quick signature check: "%PDF-"
    if (bytes.length < 5) {
      return json(400, { ok: false, error: "File is too small to be a valid PDF." });
    }
    const header = Buffer.from(bytes.slice(0, 5)).toString("utf8");
    if (header !== "%PDF-") {
      return json(400, { ok: false, error: "File does not look like a real PDF (%PDF- header missing)." });
    }

    // IMPORTANT: bucket must exist in Supabase Storage
    const bucket = "documents";

    // Unique-ish path with hash prefix (prevents collisions, helps dedupe)
    const sha = crypto.createHash("sha256").update(Buffer.from(bytes)).digest("hex").slice(0, 24);
    const path = `${auth.userId}/${Date.now()}_${sha}_${name}`;

    const admin = createClient(
      mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
      mustEnv("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false } }
    );

    const up = await admin.storage.from(bucket).upload(path, bytes, {
      contentType: "application/pdf",
      upsert: false,
    });

    if (up.error) {
      return json(500, { ok: false, error: up.error.message });
    }

    // If your bucket is PUBLIC, getPublicUrl works.
    // If your bucket is PRIVATE, switch to createSignedUrl and return signedUrl instead.
    const { data: pub } = admin.storage.from(bucket).getPublicUrl(path);

    const url = pub?.publicUrl || "";
    if (!url) {
      return json(500, { ok: false, error: "Upload succeeded but public URL could not be generated." });
    }

    return json(200, {
      ok: true,
      bucket,
      path,
      url,
      filename: name,
      bytes: bytes.length,
    });
  } catch (e: any) {
    return json(500, { ok: false, error: e?.message || String(e) });
  }
}
