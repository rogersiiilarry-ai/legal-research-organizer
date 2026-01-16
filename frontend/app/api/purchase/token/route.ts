// frontend/app/api/purchase/token/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import crypto from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ------------------------------- helpers ------------------------------- */

function json(status: number, payload: any) {
  return NextResponse.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "x-token-route": "purchase-token-v5-admin-bypass",
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

/**
 * Cookie user (browser). Uses anon key + SSR cookies.
 */
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

/**
 * Fetch profile flags (admin/free_access) via PostgREST using SRK
 * so it works even if RLS/JS-client views are quirky.
 */
async function fetchProfileFlags(userId: string): Promise<{ is_admin: boolean; free_access: boolean; free_tier: string | null }> {
  const base = mustEnv("NEXT_PUBLIC_SUPABASE_URL").replace(/\/$/, "");
  const srk = mustEnv("SUPABASE_SERVICE_ROLE_KEY");

  const url = `${base}/rest/v1/profiles?select=is_admin,free_access,free_tier&id=eq.${encodeURIComponent(userId)}&limit=1`;

  const r = await fetch(url, {
    method: "GET",
    headers: {
      apikey: srk,
      Authorization: `Bearer ${srk}`,
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`PostgREST profiles lookup failed: ${r.status} ${text}`);
  }

  const rows = (await r.json().catch(() => [])) as any[];
  const row = Array.isArray(rows) && rows[0] ? rows[0] : null;

  return {
    is_admin: !!row?.is_admin,
    free_access: !!row?.free_access,
    free_tier: row?.free_tier ? String(row.free_tier) : null,
  };
}

/**
 * PostgREST "analyses" exposes owner_id (not user_id).
 */
async function fetchAnalysisViaRest(analysisId: string): Promise<{ id: string; owner_id: string | null } | null> {
  const base = mustEnv("NEXT_PUBLIC_SUPABASE_URL").replace(/\/$/, "");
  const srk = mustEnv("SUPABASE_SERVICE_ROLE_KEY");

  const url = `${base}/rest/v1/analyses?select=id,owner_id&id=eq.${encodeURIComponent(analysisId)}&limit=1`;

  const r = await fetch(url, {
    method: "GET",
    headers: {
      apikey: srk,
      Authorization: `Bearer ${srk}`,
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`PostgREST analyses lookup failed: ${r.status} ${text}`);
  }

  const rows = (await r.json().catch(() => [])) as any[];
  if (!Array.isArray(rows) || rows.length === 0) return null;

  return {
    id: String(rows[0]?.id || "").trim(),
    owner_id: rows[0]?.owner_id ? String(rows[0].owner_id).trim() : null,
  };
}

/**
 * Insert token via PostgREST so we don't depend on JS-client schema visibility.
 */
async function insertPurchaseToken(params: { token: string; analysis_id: string; product: string; expires_at: string }) {
  const base = mustEnv("NEXT_PUBLIC_SUPABASE_URL").replace(/\/$/, "");
  const srk = mustEnv("SUPABASE_SERVICE_ROLE_KEY");

  const url = `${base}/rest/v1/purchase_tokens`;

  const r = await fetch(url, {
    method: "POST",
    headers: {
      apikey: srk,
      Authorization: `Bearer ${srk}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(params),
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`PostgREST purchase_tokens insert failed: ${r.status} ${text}`);
  }
}

/* --------------------------------- route -------------------------------- */

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const analysisId = s(body?.analysisId || body?.analysis_id);
    const product = s(body?.product) || "audit_basic"; // audit_basic | audit_pro

    if (!analysisId) return json(400, { ok: false, error: "analysisId required" });

    const isSystem = hasValidIngestSecret(req);

    // Browser user flow (cookie) OR internal system flow (secret)
    const user = isSystem ? null : await requireUserCookie();
    if (!isSystem && !user) return json(401, { ok: false, error: "Unauthorized" });

    // Confirm analysis exists
    const analysis = await fetchAnalysisViaRest(analysisId);
    if (!analysis?.id) return json(404, { ok: false, error: "Analysis not found" });

    // Enforce ownership unless admin/free_access (admins can mint tokens for any analysis)
    if (user) {
      const flags = await fetchProfileFlags(user.id);
      const isPrivileged = flags.is_admin || flags.free_access;

      if (!isPrivileged && analysis.owner_id && analysis.owner_id !== user.id) {
        return json(403, { ok: false, error: "Forbidden" });
      }
    }

    const token = tokenString();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

    await insertPurchaseToken({
      token,
      analysis_id: analysisId,
      product,
      expires_at: expiresAt,
    });

    return json(200, {
      ok: true,
      token,
      expires_at: expiresAt,
      mode: isSystem ? "system" : "user",
      product,
    });
  } catch (e: any) {
    return json(500, { ok: false, error: e?.message || "Token create error" });
  }
}
