// frontend/app/api/documents/create/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
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

function clampStr(v: any, max = 4000) {
  if (typeof v !== "string") return "";
  const s = v.trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max) : s;
}

function inferExternalSourceFromUrl(pdfUrl: string) {
  try {
    const u = new URL(pdfUrl);
    return (u.hostname || "").replace(/^www\./, "").trim();
  } catch {
    return "";
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(v: any): boolean {
  if (typeof v !== "string") return false;
  return UUID_RE.test(v.trim());
}

type AuthResult =
  | { ok: true; mode: "system"; userId: null }
  | { ok: true; mode: "user"; userId: string }
  | { ok: false; status: number; error: string };

/**
 * Accept either:
 *  - x-ingest-secret => system mode
 *  - Supabase browser session cookie => user mode
 */
async function requireSystemOrUser(req: Request): Promise<AuthResult> {
  const provided = req.headers.get("x-ingest-secret") || "";
  const expected = process.env.INGEST_SECRET || "";

  if (expected && provided && provided === expected) {
    return { ok: true, mode: "system", userId: null };
  }

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
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  return { ok: true, mode: "user", userId: data.user.id };
}

export async function POST(req: Request) {
  try {
    const auth = await requireSystemOrUser(req);
    if (auth.ok === false) return json(auth.status, { ok: false, error: auth.error });

    const body = await req.json().catch(() => ({} as any));

    const title =
      clampStr(body?.title, 240) ||
      clampStr(body?.name, 240) ||
      "";

    const pdfUrl =
      clampStr(body?.pdf_url, 2000) ||
      clampStr(body?.pdfUrl, 2000) ||
      clampStr(body?.url, 2000) ||
      "";

    const jurisdiction =
      clampStr(body?.jurisdiction, 32) ||
      "MI";

    const externalSourceExplicit =
      clampStr(body?.external_source, 160) ||
      clampStr(body?.externalSource, 160) ||
      clampStr(body?.source, 160);

    const externalSourceInferred = pdfUrl ? inferExternalSourceFromUrl(pdfUrl) : "";
    const external_source = (externalSourceExplicit || externalSourceInferred || "manual").trim();

    if (!pdfUrl) {
      return json(400, { ok: false, error: "pdf_url is required" });
    }

    // Decide owner_id:
    // - user mode => userId
    // - system mode => SYSTEM_OWNER_ID (must be UUID)
    let owner_id: string;
    if (auth.mode === "user") {
      owner_id = auth.userId;
    } else {
      const systemOwnerId = mustEnv("SYSTEM_OWNER_ID").trim();
      if (!isUuid(systemOwnerId)) {
        return json(500, { ok: false, error: "SYSTEM_OWNER_ID must be a UUID" });
      }
      owner_id = systemOwnerId;
    }

    const supabase = createClient(
      mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
      mustEnv("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false } }
    );

    // Store the URL in raw.pdf (your other routes expect this)
    const raw = {
      pdf: pdfUrl,
      uploaded_via: auth.mode === "system" ? "system" : "ui",
      created_at_client: new Date().toISOString(),
    };

    const insertRow: Record<string, any> = {
      owner_id,
      title: title || null,
      jurisdiction,
      external_source, // NOT NULL safe
      raw,
    };

    const { data, error } = await supabase
      .from("documents")
      .insert(insertRow)
      .select("id")
      .single();

    if (error) {
      return json(500, {
        ok: false,
        error: error.message,
        details: (error as any).details,
        hint: (error as any).hint,
        insertRow,
      });
    }

    return json(200, { ok: true, documentId: data.id });
  } catch (e: any) {
    return json(500, { ok: false, error: e?.message || String(e) });
  }
}
