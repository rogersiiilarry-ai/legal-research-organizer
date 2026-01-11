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

function buildPrompt(args: {
  caseName: string;
  docs: Array<{ document_id: string; title: string | null; chunks: Array<{ id: string; content: string }> }>;
}) {
  const docBlock = args.docs
    .map((d) => {
      const chunks = d.chunks.map((c) => `CHUNK_ID=${c.id}\n${c.content}`).join("\n\n");
      return `DOCUMENT_ID=${d.document_id}\nTITLE=${d.title ?? "(unknown)"}\n\n${chunks}`;
    })
    .join("\n\n====================\n\n");

  return `
You are a "Case Consistency & Fact-Mapping" research system.
You do NOT provide legal advice. You do NOT recommend actions.
You ONLY do research: detect contradictions between documents, missing links between assertions and support, timeline conflicts, identity mismatches, unclear attributions, and gaps that require additional records.

Return STRICT JSON with this schema:
{
  "summary": {
    "case_overview": string,
    "documents_reviewed": number,
    "key_entities": string[],
    "key_dates": string[],
    "key_numbers": string[]
  },
  "findings": [
    {
      "severity": "info"|"low"|"medium"|"high",
      "category": "cross_doc_conflict"|"missing_support"|"timeline_gap"|"identity_mismatch"|"ambiguity"|"other",
      "title": string,
      "detail": string,
      "evidence": { "document_ids": string[], "chunk_ids": string[], "quotes": string[] }
    }
  ]
}

CASE NAME: ${args.caseName}

CONTENT (multi-document, chunked):
${docBlock}
`.trim();
}

async function runModel(prompt: string) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  if (!apiKey) {
    return {
      summary: {
        case_overview: "Heuristic mode: no LLM configured.",
        documents_reviewed: 0,
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
            "OPENAI_API_KEY is not set, so the system cannot perform deep cross-document consistency analysis yet.",
          evidence: { document_ids: [], chunk_ids: [], quotes: [] },
        },
      ],
    };
  }

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
  if (!resp.ok) throw new Error(`LLM error (${resp.status}): ${raw.slice(0, 800)}`);

  const data = JSON.parse(raw);
  const content = safeString(data?.choices?.[0]?.message?.content);
  return JSON.parse(content);
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
    const case_id = safeString(body?.case_id);
    const owner_id = safeString(body?.owner_id);
    const maxDocs = clampInt(body?.maxDocs, 1, 10, 5);
    const maxChunksPerDoc = clampInt(body?.maxChunksPerDoc, 5, 40, 20);

    if (!case_id) return json(400, { ok: false, error: "Missing case_id" });
    if (!owner_id) return json(400, { ok: false, error: "Missing owner_id (auth user id)" });

    // Create analysis run
    const { data: analysis, error: aErr } = await supabase
      .from("analyses")
      .insert({
        owner_id,
        scope: "case",
        case_id,
        status: "running",
        started_at: new Date().toISOString(),
        model: process.env.OPENAI_MODEL || null,
        prompt_version: "case_v1",
      })
      .select("*")
      .single();

    if (aErr) return json(500, { ok: false, error: aErr.message });

    // Load case + documents
    const { data: caseRow, error: cErr } = await supabase
      .from("cases")
      .select("id,name")
      .eq("id", case_id)
      .eq("owner_id", owner_id)
      .single();

    if (cErr) throw new Error(cErr.message);

    const { data: links, error: lErr } = await supabase
      .from("case_documents")
      .select("document_id")
      .eq("case_id", case_id)
      .order("added_at", { ascending: true })
      .limit(maxDocs);

    if (lErr) throw new Error(lErr.message);

    const docIds = (links ?? []).map((x: any) => x.document_id);
    if (!docIds.length) {
      await supabase.from("analyses").update({
        status: "done",
        finished_at: new Date().toISOString(),
        summary: { case_overview: "No documents in case.", documents_reviewed: 0, key_entities: [], key_dates: [], key_numbers: [] },
        meta: { finding_count: 0 }
      }).eq("id", analysis.id);

      return json(200, { ok: true, analysis_id: analysis.id, findings: 0, message: "No documents in case." });
    }

    const docs: Array<any> = [];

    for (const id of docIds) {
      const { data: doc, error: dErr } = await supabase
        .from("documents")
        .select("id,title")
        .eq("id", id)
        .single();

      if (dErr) continue;

      const { data: chunks, error: chErr } = await supabase
        .from("chunks")
        .select("id,content,chunk_index")
        .eq("document_id", id)
        .order("chunk_index", { ascending: true })
        .limit(maxChunksPerDoc);

      if (chErr) continue;

      docs.push({
        document_id: doc.id,
        title: doc.title ?? null,
        chunks: (chunks ?? []).map((c: any) => ({ id: c.id, content: c.content })),
      });
    }

    const prompt = buildPrompt({
      caseName: caseRow?.name ?? "Untitled Case",
      docs,
    });

    const result = await runModel(prompt);

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

    const { error: uErr } = await supabase
      .from("analyses")
      .update({
        status: "done",
        finished_at: new Date().toISOString(),
        summary: {
          ...(result?.summary ?? {}),
          documents_reviewed: docs.length,
        },
        meta: { finding_count: findings.length, documents_reviewed: docs.length },
      })
      .eq("id", analysis.id);

    if (uErr) throw new Error(uErr.message);

    return json(200, { ok: true, analysis_id: analysis.id, findings: findings.length, documents_reviewed: docs.length });
  } catch (e: any) {
    return json(500, { ok: false, error: e?.message || String(e) });
  }
}
