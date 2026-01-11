// frontend/app/api/admin/set-password/route.ts
import { NextResponse } from "next/server";
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

function safeStr(v: any, max = 500) {
  if (typeof v !== "string") return "";
  const s = v.trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max) : s;
}

function isUuid(v: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
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

export async function POST(req: Request) {
  try {
    // Defense-in-depth: check secret here too (middleware should already do it)
    const provided = safeStr(req.headers.get("x-admin-secret"), 200);
    const expected = safeStr(process.env.ADMIN_SECRET, 200);

    if (!expected) {
      return json(500, { ok: false, error: "Server misconfigured: ADMIN_SECRET is not set" });
    }
    if (!provided || provided !== expected) {
      return json(401, { ok: false, error: "Unauthorized" });
    }

    const body = await readJson(req);

    const userId = safeStr(body?.userId || body?.user_id, 100);
    const password = safeStr(body?.password, 200);

    if (!userId || !isUuid(userId)) {
      return json(400, { ok: false, error: "userId must be a valid UUID" });
    }
    if (!password || password.length < 8) {
      return json(400, { ok: false, error: "password must be at least 8 characters" });
    }

    // IMPORTANT: Use the SERVICE ROLE key, and createClient with it.
    const supabase = createClient(
      mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
      mustEnv("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false } }
    );

    const { data, error } = await supabase.auth.admin.updateUserById(userId, { password });

    if (error) {
      return json(500, { ok: false, error: error.message });
    }

    return json(200, {
      ok: true,
      userId: data?.user?.id || userId,
      email: data?.user?.email || null,
      message: "Password updated",
    });
  } catch (e: any) {
    return json(500, { ok: false, error: e?.message || String(e) });
  }
}
