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
    headers: {
      "Cache-Control": "no-store",
      "x-token-route": "purchase-token-v2",
    },
  });
}

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function s(v: any) {
  return typeof v === "string" ? v.trim() : "";
}

function tokenString(bytes = 24) {
  return "tok_" + crypto.randomBytes(bytes).toString("base64url");
}

function hasValidIngestSecret(req: Request) {
  const got = s(req.headers.get("x-ingest-secret"));
  const want = s(process.env.INGEST_SECRET);
  return !!want && !!got && got === want;
}

function supabaseAdmin() {
  return createClient(
    mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
    mustEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } }
  );
}

async function requireUserCookie() {
  const cookieStore = cookies();
  const supabase = createServerClient(
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

  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) return null;
  return data.user;
}

/* --------------------------------- route -------------------------------- */

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const analysisId = s(body?.analysisId || body?.analysis_id);
    const product = s(body?.product) || "audit_basic"; // audit_basic | audit_pro

    if (!analysisId) return json(400, { ok: false, error: "analysisId required" });

    const isSystem = hasValidIngestSecret(req);
    const user = isSystem ? null : await requireUserCookie();

    if (!isSystem && !user) {
      return json(401, { ok: false, error: "Unauthorized" });
    }

    const admin = supabaseAdmin();

    // Ensure analysis exists and (if user-auth) belongs to user
    const { data: analysis, error: readErr } = await admin
      .from("analyses")
      .select("id,user_id")
      .eq("id", analysisId)
      .single();

    if (readErr || !analysis) return json(404, { ok: false, error: "Analysis not found" });

    if (user && analysis.user_id && analysis.user_id !== user.id) {
      return json(403, { ok: false, error: "Forbidden" });
    }

    const token = tokenString();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

    const { error: insErr } = await admin.from("purchase_tokens").insert({
      token,
      analysis_id: analysisId,
      product,
      expires_at: expiresAt,
    });

    if (insErr) return json(500, { ok: false, error: insErr.message });

    return json(200, { ok: true, token, expires_at: expiresAt, mode: isSystem ? "system" : "user" });
  } catch (e: any) {
    return json(500, { ok: false, error: e?.message || "Token create error" });
  }
}
