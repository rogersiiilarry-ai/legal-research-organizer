import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

/* ------------------------------- helpers ------------------------------- */

function json(status: number, payload: any) {
  return NextResponse.json(payload, { status });
}

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function parseJsonLoose(v: any) {
  if (!v) return {};
  if (typeof v === "object") return v;
  if (typeof v === "string") {
    try {
      const j = JSON.parse(v);
      return j && typeof j === "object" ? j : {};
    } catch {
      return {};
    }
  }
  return {};
}

/* -------------------------------- auth -------------------------------- */

type AuthOk =
  | { ok: true; mode: "system"; userId: null }
  | { ok: true; mode: "user"; userId: string };

type AuthErr = { ok: false; status: number; error: string };

type AuthResult = AuthOk | AuthErr;

function isAuthErr(a: AuthResult): a is AuthErr {
  return a.ok === false;
}

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
  if (error || !data?.user?.id) return { ok: false, status: 401, error: "Unauthorized" };

  return { ok: true, mode: "user", userId: data.user.id };
}

/* -------------------------------- route -------------------------------- */

export async function GET(req: Request, ctx: { params: { analysisId: string } }) {
  try {
    const auth = await requireSystemOrUser(req);
    if (isAuthErr(auth)) return json(auth.status, { ok: false, phase: "auth", error: auth.error });

    const analysisId = (ctx?.params?.analysisId || "").trim();
    if (!analysisId) return json(400, { ok: false, error: "analysisId is required" });

    const supabase = createClient(
      mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
      mustEnv("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false } }
    );

    const { data: analysis, error: aErr } = await supabase
      .from("analyses")
      .select("*")
      .eq("id", analysisId)
      .maybeSingle();

    if (aErr) return json(500, { ok: false, phase: "load_analysis", error: aErr.message });
    if (!analysis) return json(404, { ok: false, phase: "load_analysis", error: "Analysis not found" });

    if (auth.mode === "user" && analysis.owner_id && analysis.owner_id !== auth.userId) {
      return json(403, { ok: false, phase: "authz", error: "Forbidden" });
    }

    // Primary findings source: analyses.meta.findings (execute route writes here)
    const meta = parseJsonLoose((analysis as any).meta);
    const metaFindings = Array.isArray((meta as any).findings) ? (meta as any).findings : [];

    // Optional fallback: analysis_findings table (ignored if missing)
    let tableFindings: any[] = [];
    let tableWarning: string | null = null;

    if (metaFindings.length === 0) {
      const { data: f, error: fErr } = await supabase
        .from("analysis_findings")
        .select("*")
        .eq("analysis_id", analysisId)
        .order("created_at", { ascending: true });

      if (fErr) {
        tableWarning = fErr.message;
        tableFindings = [];
      } else {
        tableFindings = Array.isArray(f) ? f : [];
      }
    }

    const findings = metaFindings.length ? metaFindings : tableFindings;

    const executedTier = String((meta as any)?.executed_tier || (meta as any)?.tier || "").toLowerCase();
    const exportAllowed =
      typeof (meta as any)?.exportAllowed === "boolean" ? (meta as any).exportAllowed : executedTier === "pro";

    return json(200, {
      ok: true,
      analysisId,
      analysis,
      findings,
      exportAllowed,
      _source: metaFindings.length ? "analyses.meta.findings" : "analysis_findings",
      _tableWarning: tableWarning ? "analysis_findings unavailable; using meta-only" : null,
    });
  } catch (e: any) {
    return json(500, { ok: false, phase: "exception", error: e?.message || String(e) });
  }
}
