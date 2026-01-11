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

function safeString(v: any) {
  return typeof v === "string" ? v : "";
}

function clampInt(v: any, min: number, max: number, dflt: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/**
 * Research-only prompt. No legal advice. No recommendations.
 * Output is structured findings with evidence pointers (chunk ids).
 */
function buildPrompt(args: {
  title: string | null;
  chunks: Array<{ id: string; content: string }>;
}) {
  const chunkBlock = args.chunks
    .map((c) => `CHUNK_ID=${c.id}\n${c.content}`)
    .join("\n\n---\n\n");

  return `
You are a "Document Consistency & Fact-Mapping" research system.
You do NOT provide legal advice. You do NOT recommend actions.
You ONLY do research: extract factual assertions, map support, detect internal inconsistencies, ambiguities, timeline gaps, and missing support.

Return STRICT JSON with this schema:
{
  "summary": {
    "document_overview": string,
    "key_entities": string[],
    "key_dates": string[],
    "key_numbers": string[]
  },
  "findings": [
    {
      "severity": "info"|"low"|"medium"|"high",
      "category": "fact_conflict"|"missing_support"|"timeline_gap"|"ambiguity"|"incomplete_reference"|"other",
      "title": string,
      "detail": string,
      "evidence": { "chunk_ids": string[], "quotes": string[] }
    }
  ]
}

Document title: ${args.title ?? "(unknown)"}

CONTENT (chunked):
${chunkBlock}
`.trim();
}

/**
 * Minimal LLM caller: uses OpenAI if OPENAI_API_KEY exists, otherwise does a simple heuristic analysis.
 * Heuristic mode still returns JSON in the required shape.
 */
async function runModel(prompt: string) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  if (!apiKey) {
    // Heuristic fallback: basic "research findings" so pipeline works without LLM.
    return {
      summary: {
        document_overview: "Heuristic mode: extracted limited signals without an LLM.",
        key_entities: [],
        key_dates: [],
        key_numbers: [],
      },
      findings: [
        {
          severity: "info",
          category: "other",
          title: "LLM not configured",
          detail:
            "OPENAI_API_KEY is not set, so the system ran in heuristic mode. Configure OPENAI_API_KEY for deeper fact mapping and inconsistency detection.",
          evidence: { chunk_ids: [], quotes: [] },
        },
      ],
    };
  }

  // Chat Completions-style call (simple + widely compatible)
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: "Return only valid JSON. No markdown." },
        { role: "user", content: prompt },
      ],
    }),
  });

  const raw = await resp.text();
  if (!resp.ok) {
    throw new Error(`LLM error (${resp.status}): ${raw.slice(0, 800)}`);
  }

  const data = JSON.parse(raw);
  const content = safeString(data?.choices?.[0]?.message?.content);
  const parsed = JSON.parse(content);
  return parsed;
}

export async function POST(req: Request) {
  try {
    const supabaseUrl = mustEnv("NEXT_PUBLIC_SUPABASE_URL");
    const serviceKey = mustEnv("SUPABASE_SERVICE_ROLE_KEY");

    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
      global: { headers: { "x-application-name": "legal-research-organizer" } },
    });

    const body = await req.json().catch(() => ({}));
    const document_id = safeString(body?.document_id);
    const owner_id = safeString(body?.owner_id); // pass from client; middleware/auth should ensure correctness
    const maxChunks = clampInt(body?.maxChunks, 5, 60, 30);

    if (!document_id) return json(400, { ok: false, error: "Missing document_id" });
    if (!owner_id) return json(400, { ok: false, error: "Missing owner_id (auth user id)" });

    // Create analysis run row
    const { data: analysis, error: aErr } = await supabase
      .from("analyses")
      .insert({
        owner_id,
        scope: "document",
        document_id,
        status: "running",
        started_at: new Date().toISOString(),
        model: process.env.OPENAI_MODEL || null,
        prompt_version: "doc_v1",
      })
      .select("*")
      .single();

    if (aErr) return json(500, { ok: false, error: aErr.message });

    // Fetch doc + chunks
    const { data: doc, error: dErr } = await supabase
      .from("documents")
      .select("id,title")
      .eq("id", document_id)
      .single();

    if (dErr) throw new Error(dErr.message);

    const { data: chunks, error: cErr } = await supabase
      .from("chunks")
      .select("id,content")
      .eq("document_id", document_id)
      .order("chunk_index", { ascending: true })
      .limit(maxChunks);

    if (cErr) throw new Error(cErr.message);

    const prompt = buildPrompt({
      title: doc?.title ?? null,
      chunks: (chunks ?? []).map((c: any) => ({ id: c.id, content: c.content })),
    });

    const result = await runModel(prompt);

    // Write findings
    const findings = Array.isArray(result?.findings) ? result.findings : [];
    if (findings.length) {
      const rows = findings.map((f: any) => ({
        analysis_id: analysis.id,
        severity: safeString(f?.severity) || "info",
        category: safeString(f?.category) || "other",
        title: safeString(f?.title) || "Finding",
        detail: safeString(f?.detail) || "",
        evidence: f?.evidence ?? null,
      }));

      const { error: fErr } = await supabase.from("analysis_findings").insert(rows);
      if (fErr) throw new Error(fErr.message);
    }

    // Finalize analysis
    const { error: uErr } = await supabase
      .from("analyses")
      .update({
        status: "done",
        finished_at: new Date().toISOString(),
        summary: result?.summary ?? null,
        meta: { finding_count: findings.length },
      })
      .eq("id", analysis.id);

    if (uErr) throw new Error(uErr.message);

    return json(200, { ok: true, analysis_id: analysis.id, findings: findings.length });
  } catch (e: any) {
    return json(500, { ok: false, error: e?.message || String(e) });
  }
}
