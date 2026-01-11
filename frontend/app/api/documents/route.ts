// frontend/app/api/documents/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

export const runtime = "nodejs";

function json(status: number, payload: any) {
  return NextResponse.json(payload, { status });
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

function inferExternalSourceFromUrl(pdfUrl: string) {
  try {
    const u = new URL(pdfUrl);
    return u.hostname || "manual";
  } catch {
    return "manual";
  }
}

/**
 * Deterministic external_id that matches your existing DB pattern:
 *   url:<40-hex>
 *
 * Use SHA1 so it stays 40-hex (and matches your current records).
 */
function makeExternalIdFromUrl(pdfUrl: string) {
  const normalized = pdfUrl.trim();
  const digest = crypto.createHash("sha1").update(normalized).digest("hex"); // 40 hex
  return `url:${digest}`;
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
  if (error || !data?.user?.id) {
    return { ok: false as const, status: 401, error: "Unauthorized" };
  }
  return { ok: true as const, userId: data.user.id };
}

function dbAdmin() {
  return createClient(
    mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
    mustEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } }
  );
}

function dbErrorPayload(error: any) {
  return {
    message: error?.message,
    details: error?.details,
    hint: error?.hint,
    code: error?.code,
  };
}

function isHttpUrl(v: string) {
  return /^https?:\/\//i.test(v || "");
}

export async function GET(req: Request) {
  try {
    const auth = await requireUser();
    if (!auth.ok) return json(auth.status, { ok: false, error: auth.error });

    const u = new URL(req.url);
    const limit = Math.max(1, Math.min(200, Number(u.searchParams.get("limit") || "50")));

    const admin = dbAdmin();

    const { data, error } = await admin
      .from("documents")
      .select("id, external_id, title, jurisdiction, source, external_source, raw, created_at")
      .eq("owner_id", auth.userId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) return json(500, { ok: false, error: error.message, db: dbErrorPayload(error) });
    return json(200, { ok: true, documents: data || [] });
  } catch (e: any) {
    return json(500, { ok: false, error: e?.message || String(e) });
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireUser();
    if (!auth.ok) return json(auth.status, { ok: false, error: auth.error });

    const body = await req.json().catch(() => ({}));

    const title = s(body?.title, 240) || null;
    const jurisdiction = s(body?.jurisdiction, 40) || null;

    const pdfUrl =
      s(body?.pdf_url) ||
      s(body?.pdfUrl) ||
      s(body?.url) ||
      s(body?.pdf) ||
      s(body?.raw?.pdf) ||
      s(body?.raw?.pdf_url);

    if (!pdfUrl) return json(400, { ok: false, error: "pdf_url is required" });
    if (!isHttpUrl(pdfUrl)) return json(400, { ok: false, error: `pdf_url must be http(s). Got: ${pdfUrl}` });

    const external_source =
      s(body?.external_source, 240) ||
      s(body?.externalSource, 240) ||
      inferExternalSourceFromUrl(pdfUrl);

    const source = s(body?.source, 80) || "pdf_url";

    // Always store BOTH fields so downstream routes can safely prefer a real URL.
    const rawIn = typeof body?.raw === "object" && body?.raw ? body.raw : {};
    const raw = { ...rawIn, pdf: pdfUrl, pdf_url: pdfUrl };

    // external_id must be stable and match your existing DB convention.
    const external_id =
      s(body?.external_id, 240) ||
      s(body?.externalId, 240) ||
      makeExternalIdFromUrl(pdfUrl);

    const admin = dbAdmin();

    const { data, error } = await admin
      .from("documents")
      .upsert(
        {
          owner_id: auth.userId,
          external_id,
          title,
          jurisdiction,
          source,
          external_source,
          raw,
        },
        {
          // If your unique index is composite, change to: "owner_id,external_id"
          onConflict: "external_id",
        }
      )
      .select("id, external_id")
      .single();

    if (error) {
      return json(500, { ok: false, error: error.message, db: dbErrorPayload(error) });
    }

    return json(200, { ok: true, documentId: data.id, external_id: data.external_id });
  } catch (e: any) {
    return json(500, { ok: false, error: e?.message || String(e) });
  }
}
