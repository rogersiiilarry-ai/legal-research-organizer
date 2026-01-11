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

function sha1(input: string) {
  return crypto.createHash("sha1").update(input).digest("hex");
}

function inferExternalSourceFromUrl(pdfUrl: string) {
  try {
    const u = new URL(pdfUrl);
    return (u.hostname || "").replace(/^www\./, "").trim();
  } catch {
    return "manual";
  }
}

async function requireUser(req: Request) {
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
    const auth = await requireUser(req);
    if (!auth.ok) return json(auth.status, { ok: false, error: auth.error });

    const body = await req.json().catch(() => ({} as any));

    const title = s(body?.title, 240) || null;
    const jurisdiction = s(body?.jurisdiction, 32) || "MI";

    const pdfUrl =
      s(body?.pdf_url, 2000) ||
      s(body?.pdfUrl, 2000) ||
      s(body?.url, 2000);

    if (!pdfUrl) return json(400, { ok: false, error: "pdf_url is required" });

    const external_source =
      s(body?.external_source, 160) ||
      s(body?.externalSource, 160) ||
      inferExternalSourceFromUrl(pdfUrl) ||
      "manual";

    // deterministic id for URL (works for storage public URLs too)
    const external_id =
      s(body?.external_id, 240) ||
      s(body?.externalId, 240) ||
      `url:${sha1(pdfUrl)}`;

    const rawIn = body?.raw && typeof body.raw === "object" ? body.raw : {};
    const raw = {
      ...rawIn,
      pdf_url: pdfUrl,
      pdf: pdfUrl, // backwards compatibility
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
        {
          // IMPORTANT: set this to whatever unique index you actually have
          // If you truly have UNIQUE(external_source, external_id), keep this:
          onConflict: "external_source,external_id",
        }
      )
      .select("id")
      .single();

    if (error) return json(500, { ok: false, error: error.message });

    return json(200, { ok: true, documentId: data.id });
  } catch (e: any) {
    return json(500, { ok: false, error: e?.message || String(e) });
  }
}
