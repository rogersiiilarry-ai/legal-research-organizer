// frontend/app/api/audit/execute/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ------------------------------- helpers ------------------------------- */

function json(status: number, payload: any) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "no-store" } });
}

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

async function readJson(req: Request): Promise<any> {
  const raw = await req.text().catch(() => "");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function safeStr(v: any, max = 4000) {
  if (typeof v !== "string") return "";
  const s = v.trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max) : s;
}

function toBool(v: any) {
  return v === true || v === "true" || v === 1 || v === "1";
}

function normalizeTier(v: any): "basic" | "pro" {
  const t = safeStr(v, 20).toLowerCase();
  return t === "pro" ? "pro" : "basic";
}

/* -------------------------------- auth -------------------------------- */

type AuthOk =
  | { ok: true; mode: "system"; userId: null }
  | { ok: true; mode: "user"; userId: string };

type AuthErr = { ok: false; status: number; error: string };
type Auth = AuthOk | AuthErr;

function isAuthErr(a: Auth): a is AuthErr {
  return a.ok === false;
}

async function requireSystemOrUser(req: Request): Promise<Auth> {
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

/* ---------------------------- entitlements ---------------------------- */

function isAdminAllowlist(userId: string | null) {
  if (!userId) return false;
  const raw = process.env.ADMIN_USER_IDS || "";
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.includes(userId);
}

type DbEntitlement = { isAdmin: boolean; freeAccess: boolean; freeTier: "basic" | "pro" | null };

async function tryGetDbEntitlement(supabase: any, userId: string): Promise<DbEntitlement> {
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("is_admin, free_access, free_tier")
      .eq("id", userId)
      .maybeSingle();

    if (error || !data) return { isAdmin: false, freeAccess: false, freeTier: null };

    const isAdmin = toBool((data as any).is_admin);
    const freeAccess = toBool((data as any).free_access);
    const ft = safeStr((data as any).free_tier, 20).toLowerCase();
    const freeTier = ft === "pro" ? "pro" : ft === "basic" ? "basic" : null;

    return { isAdmin, freeAccess, freeTier };
  } catch {
    return { isAdmin: false, freeAccess: false, freeTier: null };
  }
}

function resolveAccess(input: {
  authMode: "system" | "user";
  userId: string | null;
  analysisMeta: any;
  dbEntitlement: DbEntitlement | null;
}) {
  const { authMode, userId, analysisMeta, dbEntitlement } = input;

  if (authMode === "system") {
    const tier = normalizeTier(analysisMeta?.tier);
    return { allowed: true as const, tier, isAdmin: true as const, exportAllowed: tier === "pro" };
  }

  const isAdmin = isAdminAllowlist(userId) || !!dbEntitlement?.isAdmin;
  if (isAdmin) {
    return { allowed: true as const, tier: "pro" as const, isAdmin: true as const, exportAllowed: true as const };
  }

  if (dbEntitlement?.freeAccess) {
    const tier = dbEntitlement.freeTier || "basic";
    return { allowed: true as const, tier, isAdmin: false as const, exportAllowed: tier === "pro" };
  }

  // paid flag (set by webhook or manual)
  const paid = toBool(analysisMeta?.paid);
  if (!paid) return { allowed: false as const, reason: "PAYMENT_REQUIRED" as const };

  const tier = normalizeTier(analysisMeta?.tier);
  return { allowed: true as const, tier, isAdmin: false as const, exportAllowed: tier === "pro" };
}

/* ---------------------------- audit logic (simple) ---------------------------- */

type ChunkRow = { chunk_index: number; content: string };

function clip(s: string, max = 320) {
  const t = safeStr(s, max + 50);
  return t.length > max ? t.slice(0, max).trimEnd() + "…" : t;
}

function normalizeText(s: string) {
  return (s || "")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitSentences(text: string) {
  const t = normalizeText(text);
  if (!t) return [];
  return t
    .split(/(?<=[.!?])\s+|\n+(?=[A-Z0-9])/g)
    .map((x) => x.trim())
    .filter(Boolean);
}

function countLikelyStatements(text: string) {
  return splitSentences(text).length;
}

function buildFindings(chunks: ChunkRow[], tier: "basic" | "pro") {
  const texts = chunks.map((c) => safeStr(c.content, 200000)).filter(Boolean);
  const joined = normalizeText(texts.join("\n\n"));

  const chunkCount = texts.length;
  const statementCount = joined ? countLikelyStatements(joined) : 0;

  const findings: any[] = [
    {
      id: `coverage_${Date.now()}`,
      title: "Source coverage snapshot",
      severity: "info",
      claim: `Document is materialized into ${chunkCount} text chunks (~${statementCount} sentence-like statements).`,
      evidence: [
        { type: "metric", key: "tier", value: tier },
        { type: "metric", key: "chunk_count", value: chunkCount },
        { type: "metric", key: "statement_estimate", value: statementCount },
      ],
    },
    {
      id: `gaps_${Date.now()}`,
      title: "Potential coverage gaps",
      severity: "warn",
      claim:
        "This audit only evaluates extracted record text. Exhibits, images, scanned pages, or missing attachments may not be represented unless OCR is applied.",
      evidence: [{ type: "note", value: "If the PDF is scanned, text extraction may be incomplete unless OCR is used." }],
    },
  ];

  // very lightweight signals (keep deterministic)
  const moneyRe = /\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?/g;
  const dateRe =
    /\b(?:(?:0?[1-9]|1[0-2])[\/\-](?:0?[1-9]|[12]\d|3[01])[\/\-](?:\d{2}|\d{4})|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[\.\s]+(?:0?[1-9]|[12]\d|3[01]),?\s+(?:\d{4}))\b/i;

  const sampleSentences = splitSentences(joined).slice(0, 200);

  const moneyHits = sampleSentences.filter((s) => moneyRe.test(s));
  const dateHits = sampleSentences.filter((s) => dateRe.test(s));

  if (dateHits.length) {
    findings.push({
      id: `dates_${Date.now()}`,
      title: "Timeline signals",
      severity: "info",
      claim: `Detected date-like strings in extracted text (sampled).`,
      evidence: dateHits.slice(0, 6).map((s) => ({ type: "sentence", snippet: clip(s) })),
    });
  }

  if (moneyHits.length) {
    findings.push({
      id: `money_${Date.now()}`,
      title: "Fees and money references",
      severity: "info",
      claim: `Detected amount patterns in extracted text (sampled).`,
      evidence: moneyHits.slice(0, 6).map((s) => ({ type: "sentence", snippet: clip(s) })),
    });
  }

  return { joined, findings, chunkCount, statementCount };
}

/* ---------------------------------- route ---------------------------------- */

export async function POST(req: Request) {
  try {
    const auth = await requireSystemOrUser(req);
    if (isAuthErr(auth)) return json(auth.status, { ok: false, error: auth.error });

    const body = await readJson(req);
    const analysisId = safeStr(body?.analysisId || body?.analysis_id || "", 80);
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

    if (aErr) return json(500, { ok: false, error: aErr.message });
    if (!analysis) return json(404, { ok: false, error: "Analysis not found" });

    // owner check
    if (auth.mode === "user" && (analysis as any).owner_id && (analysis as any).owner_id !== auth.userId) {
      return json(403, { ok: false, error: "Forbidden" });
    }

    const dbEntitlement = auth.mode === "user" ? await tryGetDbEntitlement(supabase, auth.userId) : null;

    const access = resolveAccess({
      authMode: auth.mode,
      userId: auth.mode === "user" ? auth.userId : null,
      analysisMeta: (analysis as any).meta || {},
      dbEntitlement,
    });

    if (!access.allowed) {
      return json(200, {
        ok: true,
        requires_payment: true,
        code: "PAYMENT_REQUIRED",
        analysisId,
      });
    }

    const docId = (analysis as any).target_document_id;
    if (!docId) return json(400, { ok: false, error: "analysis.target_document_id is missing" });

    const { data: chunkRows, error: cErr } = await supabase
      .from("chunks")
      .select("chunk_index, content")
      .eq("document_id", docId)
      .order("chunk_index", { ascending: true });

    if (cErr) return json(500, { ok: false, error: cErr.message });

    const chunks: ChunkRow[] = (chunkRows || [])
      .map((r: any) => ({
        chunk_index: Number(r.chunk_index ?? 0),
        content: safeStr(r.content, 200000),
      }))
      .filter((r) => !!r.content);

    const { joined, findings, chunkCount, statementCount } = buildFindings(chunks, access.tier);

    if (!joined) {
      const newMeta = {
        ...(((analysis as any).meta) || {}),
        findings,
        executed_at: new Date().toISOString(),
        executed_tier: access.tier,
        exportAllowed: access.exportAllowed,
        stats: { chunkCount: 0, statementEstimate: 0 },
      };

      await supabase
        .from("analyses")
        .update({
          status: "done",
          summary: "No text available to audit (no chunks found). Materialize the document first.",
          meta: newMeta,
          error: null,
        })
        .eq("id", analysisId);

      return json(200, {
        ok: true,
        analysisId,
        status: "done",
        tier: access.tier,
        exportAllowed: access.exportAllowed,
        summary: "No text available to audit (no chunks found). Materialize the document first.",
        findings: newMeta.findings,
      });
    }

    const summary =
      `Audit executed (${access.tier.toUpperCase()}). ` +
      `Coverage: ${chunkCount} chunks parsed (~${statementCount} statements). ` +
      `Findings generated: ${findings.length}.`;

    const newMeta = {
      ...(((analysis as any).meta) || {}),
      findings,
      executed_at: new Date().toISOString(),
      executed_tier: access.tier,
      exportAllowed: access.exportAllowed,
      stats: { chunkCount, statementEstimate: statementCount },
    };

    const { error: uErr } = await supabase
      .from("analyses")
      .update({
        status: "done",
        summary,
        meta: newMeta,
        error: null,
      })
      .eq("id", analysisId);

    if (uErr) return json(500, { ok: false, error: uErr.message });

    return json(200, {
      ok: true,
      analysisId,
      status: "done",
      tier: access.tier,
      exportAllowed: access.exportAllowed,
      summary,
      findings,
    });
  } catch (e: any) {
    return json(500, { ok: false, error: e?.message || String(e) });
  }
}