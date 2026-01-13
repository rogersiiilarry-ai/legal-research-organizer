// frontend/app/api/audit/execute/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

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

function normalizeText(s: string) {
  return s
    .replace(/\u0000/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function clip(s: string, max = 360) {
  const t = safeStr(s, max + 40);
  return t.length > max ? t.slice(0, max).trimEnd() + "…" : t;
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

type ChunkRow = { chunk_index: number; content: string };

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

  // Allow "system" calls for automated pipelines (ingest secret)
  if (expected && provided && provided === expected) {
    return { ok: true, mode: "system", userId: null };
  }

  // Otherwise require a logged-in user via Supabase auth cookie
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

/* ---------------------------- admin / entitlements ---------------------------- */

function isAdminAllowlist(userId: string | null) {
  if (!userId) return false;
  const raw = process.env.ADMIN_USER_IDS || "";
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.includes(userId);
}

type DbEntitlement = {
  isAdmin: boolean;
  freeAccess: boolean;
  freeTier: "basic" | "pro" | null;
};

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

  // System pipeline calls (ingest secret) always allowed; tier comes from analysis meta
  if (authMode === "system") {
    const tier = normalizeTier(analysisMeta?.tier);
    return { allowed: true as const, tier, isAdmin: true as const, exportAllowed: tier === "pro" };
  }

  const isAdmin = isAdminAllowlist(userId) || !!dbEntitlement?.isAdmin;
  if (isAdmin) {
    return {
      allowed: true as const,
      tier: "pro" as const,
      isAdmin: true as const,
      exportAllowed: true as const,
    };
  }

  if (dbEntitlement?.freeAccess) {
    const tier = dbEntitlement.freeTier || "basic";
    return { allowed: true as const, tier, isAdmin: false as const, exportAllowed: tier === "pro" };
  }

  const paid = !!analysisMeta?.paid;
  if (!paid) return { allowed: false as const, reason: "PAYMENT_REQUIRED" as const };

  const tier = normalizeTier(analysisMeta?.tier);
  return { allowed: true as const, tier, isAdmin: false as const, exportAllowed: tier === "pro" };
}

/* -------------------------- deterministic audit logic -------------------------- */

function findSentenceEvidence(chunks: ChunkRow[], re: RegExp, maxHits: number) {
  const hits: Array<{ chunk_index: number; sentence: string; match: string }> = [];
  for (const ch of chunks) {
    const sentences = splitSentences(ch.content);
    for (const s of sentences) {
      const m = s.match(re);
      if (m) {
        hits.push({ chunk_index: ch.chunk_index, sentence: s, match: m[0] });
        if (hits.length >= maxHits) return hits;
      }
    }
  }
  return hits;
}

function extractTimelineFindings(chunks: ChunkRow[]) {
  const dateRe =
    /\b(?:(?:0?[1-9]|1[0-2])[\/\-](?:0?[1-9]|[12]\d|3[01])[\/\-](?:\d{2}|\d{4})|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[\.\s]+(?:0?[1-9]|[12]\d|3[01]),?\s+(?:\d{4}))\b/i;

  const hits = findSentenceEvidence(chunks, dateRe, 20);

  if (!hits.length) {
    return [
      {
        id: `f_timeline_none_${Date.now()}`,
        title: "Timeline signals",
        severity: "warn",
        claim:
          "No obvious date strings were detected in the extracted text. The record may be scanned, incomplete, or dates are encoded in exhibits.",
        explanation: {
          summary: "Automated timeline extraction relies on textual dates.",
          whyItMatters: "Missing dates can prevent automated sequencing of events.",
          limits: "Research output only; not legal advice.",
        },
        evidence: [],
      },
    ];
  }

  const uniq = new Map<string, { count: number; samples: Array<{ chunk_index: number; sentence: string }> }>();
  for (const h of hits) {
    const key = h.match.replace(/\s+/g, " ").trim();
    const cur = uniq.get(key) || { count: 0, samples: [] };
    cur.count += 1;
    if (cur.samples.length < 3) cur.samples.push({ chunk_index: h.chunk_index, sentence: h.sentence });
    uniq.set(key, cur);
  }

  const sorted = [...uniq.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 10);

  return [
    {
      id: `f_timeline_${Date.now()}`,
      title: "Timeline signals",
      severity: "info",
      claim: `Detected ${hits.length} sentence(s) containing date-like strings. Top unique dates: ${sorted
        .map(([d]) => d)
        .join(", ")}.`,
      explanation: {
        summary: "This extracts date-like strings to help assemble a timeline from the record text.",
        whyItMatters: "Timeline alignment is necessary for spotting sequence conflicts (e.g., impossible ordering).",
        limits: "Heuristic extraction; dates in exhibits/images may be missing.",
      },
      evidence: sorted.flatMap(([date, v]) => [
        { type: "date_candidate", value: date, count: v.count },
        ...v.samples.map((s) => ({
          type: "sentence",
          chunk_index: s.chunk_index,
          snippet: clip(s.sentence, 320),
        })),
      ]),
    },
  ];
}

function extractMoneyFindings(chunks: ChunkRow[]) {
  const moneyRe = /\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\b\d{1,3}(?:,\d{3})*(?:\.\d{2})\b/g;
  const feeContextRe = /\b(fine|fee|costs?|restitution|assessment|bond|bail|payment|late fee|surcharge)\b/i;

  const hits: Array<{ chunk_index: number; sentence: string; amounts: string[] }> = [];
  for (const ch of chunks) {
    const sentences = splitSentences(ch.content);
    for (const s of sentences) {
      const amounts = s.match(moneyRe) || [];
      if (amounts.length && feeContextRe.test(s)) {
        hits.push({ chunk_index: ch.chunk_index, sentence: s, amounts: amounts.slice(0, 6) });
        if (hits.length >= 20) break;
      }
    }
    if (hits.length >= 20) break;
  }

  if (!hits.length) {
    return [
      {
        id: `f_money_none_${Date.now()}`,
        title: "Fees and money references",
        severity: "info",
        claim: "No fee/cost sentences with recognizable dollar/amount patterns were detected in extracted text.",
        explanation: {
          summary: "This scan looks for amounts near fee/cost language.",
          whyItMatters: "Amounts are commonly the source of inconsistencies across docket/assessment sheets.",
          limits: "Scanned ledgers may not extract cleanly without OCR.",
        },
        evidence: [],
      },
    ];
  }

  const amountCounts = new Map<string, number>();
  for (const h of hits) {
    for (const a of h.amounts) {
      const k = a.replace(/\s+/g, " ").trim();
      amountCounts.set(k, (amountCounts.get(k) || 0) + 1);
    }
  }
  const topAmounts = [...amountCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);

  return [
    {
      id: `f_money_${Date.now()}`,
      title: "Fees and money references",
      severity: "info",
      claim: `Detected ${hits.length} sentence(s) with money/amount patterns near fee/cost language. Top amounts: ${topAmounts
        .map(([a]) => a)
        .join(", ")}.`,
      explanation: {
        summary: "This flags places where fees/costs appear so you can cross-check amounts across documents.",
        whyItMatters: "Conflicting totals or duplicate assessments are common operational errors.",
        limits: "This does not decide correctness; it only highlights evidence locations.",
      },
      evidence: [
        ...topAmounts.map(([a, c]) => ({ type: "amount", value: a, count: c })),
        ...hits.slice(0, 10).map((h) => ({
          type: "sentence",
          chunk_index: h.chunk_index,
          snippet: clip(h.sentence, 340),
          amounts: h.amounts,
        })),
      ],
    },
  ];
}

function extractExhibitFindings(chunks: ChunkRow[]) {
  const exhibitRe =
    /\b(exhibit\s+[A-Z0-9]+|attachment\s+\d+|see\s+attached|appendix\s+[A-Z0-9]+|photo(?:graph)?s?|video|bodycam|dashcam)\b/i;
  const hits = findSentenceEvidence(chunks, exhibitRe, 18);

  if (!hits.length) {
    return [
      {
        id: `f_exhibits_none_${Date.now()}`,
        title: "Exhibits and attachments references",
        severity: "info",
        claim: "No explicit exhibit/attachment/media references detected in extracted text.",
        explanation: {
          summary: "This looks for terms indicating referenced exhibits, attachments, or media.",
          whyItMatters: "Referenced-but-missing materials can create hidden gaps in automated review.",
          limits: "Absence of terms does not mean absence of exhibits.",
        },
        evidence: [],
      },
    ];
  }

  return [
    {
      id: `f_exhibits_${Date.now()}`,
      title: "Exhibits and attachments references",
      severity: "warn",
      claim: `Detected ${hits.length} sentence(s) referencing exhibits/attachments/media. Verify those items are included and text-extractable (OCR if scanned).`,
      explanation: {
        summary: "Exhibits/media frequently contain key facts that are not present in narrative text.",
        whyItMatters: "If exhibits are missing or not extracted, the audit may miss contradictions or corroboration.",
        limits: "This is a coverage warning; it is not a merits finding.",
      },
      evidence: hits.map((h) => ({
        type: "sentence",
        chunk_index: h.chunk_index,
        snippet: clip(h.sentence, 340),
        match: h.match,
      })),
    },
  ];
}

function extractPartiesAndCaseSignals(chunks: ChunkRow[]) {
  const caseNoRe =
    /\b(case\s*(no\.?|number)|docket\s*(no\.?|number))\s*[:#]?\s*([A-Z0-9\-\/\.]{4,})\b/i;
  const courtRe =
    /\b(circuit\s+court|district\s+court|court\s+of\s+appeals|supreme\s+court|municipal\s+court)\b/i;
  const judgeRe =
    /\b(judge|magistrate|hon\.)\s+([A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’-]+){0,2})\b/i;
  const partyRe = /\b(plaintiff|defendant|petitioner|respondent)\b/i;

  const caseHits = findSentenceEvidence(chunks, caseNoRe, 8);
  const courtHits = findSentenceEvidence(chunks, courtRe, 8);
  const judgeHits = findSentenceEvidence(chunks, judgeRe, 8);
  const partyHits = findSentenceEvidence(chunks, partyRe, 10);

  const evidence: any[] = [];
  for (const h of caseHits)
    evidence.push({ type: "sentence", chunk_index: h.chunk_index, snippet: clip(h.sentence, 340), match: h.match });
  for (const h of courtHits)
    evidence.push({ type: "sentence", chunk_index: h.chunk_index, snippet: clip(h.sentence, 340), match: h.match });
  for (const h of judgeHits)
    evidence.push({ type: "sentence", chunk_index: h.chunk_index, snippet: clip(h.sentence, 340), match: h.match });
  for (const h of partyHits)
    evidence.push({ type: "sentence", chunk_index: h.chunk_index, snippet: clip(h.sentence, 340), match: h.match });

  if (!evidence.length) {
    return [
      {
        id: `f_metadata_none_${Date.now()}`,
        title: "Case metadata signals",
        severity: "info",
        claim: "No obvious case-number/court/judge/party role patterns detected in extracted text.",
        explanation: {
          summary: "This tries to pull basic case metadata from the extracted record text.",
          whyItMatters: "Accurate identifiers help prevent mixing records across matters.",
          limits: "Many PDFs store this in headers/scan images that may not extract.",
        },
        evidence: [],
      },
    ];
  }

  return [
    {
      id: `f_metadata_${Date.now()}`,
      title: "Case metadata signals",
      severity: "info",
      claim: "Detected likely case metadata references (case number/court/judge/party roles). Review and confirm identifiers.",
      explanation: {
        summary: "This highlights where the record text mentions key identifiers.",
        whyItMatters: "Identifier mismatches are a common source of downstream confusion.",
        limits: "Heuristic; verify in the source PDF.",
      },
      evidence,
    },
  ];
}

function buildCoverageFindings(chunks: ChunkRow[], accessTier: "basic" | "pro") {
  const texts = chunks.map((c) => safeStr(c.content, 200000)).filter(Boolean);
  const joined = normalizeText(texts.join("\n\n"));
  const chunkCount = texts.length;
  const statementCount = joined ? countLikelyStatements(joined) : 0;

  const now = Date.now();

  const coverage = {
    id: `f_${now}_coverage`,
    title: "Source coverage snapshot",
    severity: "info",
    claim: `Document is materialized into ${chunkCount} text chunks (~${statementCount} sentence-like statements).`,
    explanation: {
      summary: "This measures how much extracted text exists for review.",
      whyItMatters: "If text is missing, inconsistencies in that missing portion cannot be detected.",
      limits: "Research output only; not legal advice.",
    },
    evidence: [
      { type: "metric", key: "tier", value: accessTier },
      { type: "metric", key: "chunk_count", value: chunkCount },
      { type: "metric", key: "statement_estimate", value: statementCount },
    ],
  };

  const gaps = {
    id: `f_${now}_gaps`,
    title: "Potential coverage gaps",
    severity: "warn",
    claim:
      "This audit only evaluates extracted record text. Exhibits, images, scanned pages, or missing attachments may not be represented unless OCR is applied.",
    explanation: {
      summary: "Common extraction limitations can hide content from automated review.",
      whyItMatters: "Hidden/unaligned content can create false confidence in completeness.",
      limits: "Completeness warning only; not a finding about merits.",
    },
    evidence: [{ type: "note", value: "If the PDF is scanned, text extraction may be incomplete unless OCR is used." }],
  };

  return { coverage, gaps, joined, chunkCount, statementCount };
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

    // Ownership guard (supports either owner_id or user_id depending on schema evolution)
    const ownerId = (analysis as any).owner_id || (analysis as any).user_id || null;
    if (auth.mode === "user" && ownerId && ownerId !== auth.userId) {
      return json(403, { ok: false, error: "Forbidden" });
    }

    const dbEntitlement = auth.mode === "user" ? await tryGetDbEntitlement(supabase, auth.userId) : null;

    const access = resolveAccess({
      authMode: auth.mode,
      userId: auth.mode === "user" ? auth.userId : null,
      analysisMeta: (analysis as any).meta || {},
      dbEntitlement,
    });

    // IMPORTANT: Don't hard-fail. Tell the client to start Stripe Checkout.
    if (!access.allowed) {
      const meta = (((analysis as any).meta) || {}) as any;
      return json(200, {
        ok: true,
        requires_payment: true,
        code: "PAYMENT_REQUIRED",
        analysisId,
        requestedTier: normalizeTier(meta?.tier),
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

    const { coverage, gaps, joined, chunkCount, statementCount } = buildCoverageFindings(chunks, access.tier);

    // If there is no extractable text, persist a "done" analysis with warnings.
    if (!joined) {
      const newMeta = {
        ...(((analysis as any).meta) || {}),
        findings: [coverage, gaps],
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

    const metaSignals = extractPartiesAndCaseSignals(chunks);
    const timeline = extractTimelineFindings(chunks);
    const money = extractMoneyFindings(chunks);
    const exhibits = extractExhibitFindings(chunks);

    const findings = [coverage, gaps, ...metaSignals, ...timeline, ...money, ...exhibits];

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