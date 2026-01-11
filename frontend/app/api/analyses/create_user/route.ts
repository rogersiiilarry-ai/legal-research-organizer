// frontend/app/api/analyses/create_user/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

/* ------------------------------- helpers ------------------------------- */

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [k: string]: JsonValue };

function json(status: number, payload: any) {
  return NextResponse.json(payload, { status });
}

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function isObject(v: unknown): v is Record<string, any> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function clampStr(v: unknown, max = 240): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

/* ------------------------- scope/kind normalization ------------------------- */
/**
 * DB constraint:
 * scope must be one of: 'document' | 'case' | 'upload' | 'video'
 *
 * We accept "kind" from callers (e.g. case_fact_audit) and infer scope when missing.
 */
type Scope = "document" | "case" | "upload" | "video";

function normalizeScopeAndKind(input: any): { scope: Scope; kind: string } {
  const rawScope = clampStr(input?.scope, 40);
  const rawKind = clampStr(input?.kind, 80) || clampStr(input?.analysisKind, 80);

  // Back-compat: some callers sent `kind` in place of `scope`
  const maybeKind =
    rawKind ||
    clampStr(input?.scope, 80) ||
    clampStr(input?.requestedKind, 80);

  const kind = maybeKind || "case_fact_audit";

  if (
    rawScope === "document" ||
    rawScope === "case" ||
    rawScope === "upload" ||
    rawScope === "video"
  ) {
    return { scope: rawScope, kind };
  }

  const k = kind.toLowerCase();
  if (k.startsWith("case")) return { scope: "case", kind };
  if (k.startsWith("doc") || k.includes("document")) return { scope: "document", kind };
  if (k.startsWith("upload")) return { scope: "upload", kind };
  if (k.startsWith("video")) return { scope: "video", kind };

  return { scope: "case", kind };
}

/* -------------------------------- auth -------------------------------- */

type AuthOk = { ok: true; userId: string };
type AuthErr = { ok: false; status: number; error: string };
type AuthResult = AuthOk | AuthErr;

async function requireUser(): Promise<AuthResult> {
  const cookieStore = cookies();

  const supabase = createServerClient(
    mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
    mustEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        // In Route Handlers, Next's cookies() is effectively read-only.
        // We still provide typed no-ops to satisfy the adapter contract.
        set(name: string, value: string, options: any) {},
        remove(name: string, options: any) {},
      },
    }
  );

  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) return { ok: false, status: 401, error: "Unauthorized" };

  return { ok: true, userId: data.user.id };
}

/* ------------------------------ body reader ------------------------------ */

async function readJson(req: Request): Promise<Record<string, any>> {
  try {
    const buf = await req.arrayBuffer();
    const txt = Buffer.from(buf).toString("utf8").trim();
    if (!txt) return {};
    const parsed = JSON.parse(txt);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/* -------------------------------- route -------------------------------- */

export async function POST(req: Request) {
  try {
    // User auth
    const auth = await requireUser();
    if (!auth.ok) return json(auth.status, { ok: false, phase: "auth", error: auth.error });

    // Admin (service role)
    const supabaseUrl = mustEnv("NEXT_PUBLIC_SUPABASE_URL");
    const serviceKey = mustEnv("SUPABASE_SERVICE_ROLE_KEY");
    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
      global: { headers: { "x-application-name": "legal-research-organizer" } },
    });

    const body = await readJson(req);

    const title = clampStr(body?.title, 240) || null;
    const status = clampStr(body?.status, 40) || "queued";

    const target_document_id = clampStr(body?.target_document_id, 80);
    const target_case_id = clampStr(body?.target_case_id, 80);

    const metaIn = isObject(body?.meta) ? body.meta : {};
    const { scope, kind } = normalizeScopeAndKind(body);

    // Enforce owner_id = signed-in user (no override)
    const owner_id = auth.userId;

    const meta: Record<string, any> = {
      ...metaIn,
      kind,
      created_via: "user",
      user_id: auth.userId,
    };

    const insertRow: Record<string, any> = {
      owner_id,
      scope,
      title: title || `${kind} (${new Date().toISOString()})`,
      status,
      meta,
      target_document_id: target_document_id || null,
      target_case_id: target_case_id || null,
    };

    const { data, error } = await admin
      .from("analyses")
      .insert(insertRow)
      .select("*")
      .single();

    if (error) {
      return json(500, {
        ok: false,
        phase: "insert",
        error: error.message,
        details: (error as any)?.details,
        code: (error as any)?.code,
      });
    }

    return json(200, {
      ok: true,
      phase: "created",
      analysisId: data?.id,
      analysis: data,
    });
  } catch (e: any) {
    return json(500, { ok: false, phase: "exception", error: e?.message || String(e) });
  }
}
