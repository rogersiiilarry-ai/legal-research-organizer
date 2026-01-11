// frontend/lib/openaiTools.js
// Minimal OpenAI helpers for /api/search
// Uses Responses API via fetch (no SDK dependency).

const OPENAI_URL = "https://api.openai.com/v1/responses";

function getKey() {
  return process.env.OPENAI_API_KEY || "";
}

function getModel() {
  return process.env.OPENAI_MODEL || "gpt-4.1-mini";
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// Attempt to extract text from Responses API response
function extractOutputText(resp) {
  if (!resp) return "";
  if (typeof resp.output_text === "string") return resp.output_text;

  // Fallback: walk output -> message -> content -> output_text
  const out = Array.isArray(resp.output) ? resp.output : [];
  for (const item of out) {
    if (item?.type === "message" && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c?.type === "output_text" && typeof c.text === "string") return c.text;
      }
    }
  }
  return "";
}

async function callOpenAI({ input, maxOutputTokens = 500 }) {
  const apiKey = getKey();
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: getModel(),
      input,
      max_output_tokens: maxOutputTokens,
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`OpenAI error (${res.status}): ${t.slice(0, 800)}`);
  }

  return res.json();
}

/**
 * planQueries({ q })
 * Returns: { queries: string[], doctrines: string[] }
 */
export async function planQueries({ q }) {
  const query = typeof q === "string" ? q.trim() : "";
  if (!query) return { queries: [], doctrines: [] };

  const prompt = [
    "You are assisting legal research query planning (not legal advice).",
    "Return STRICT JSON only (no markdown, no commentary).",
    "Schema:",
    '{ "queries": string[], "doctrines": string[] }',
    "",
    "Rules:",
    "- queries: up to 3 short alternative search queries that broaden/clarify the topic.",
    "- doctrines: up to 6 short legal issue/doctrine keywords.",
    "- Do not include citations.",
    "",
    `USER_QUERY: ${query}`,
  ].join("\n");

  const resp = await callOpenAI({
    input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
    maxOutputTokens: 350,
  });

  const text = extractOutputText(resp).trim();
  const parsed = safeJsonParse(text);

  if (!parsed || typeof parsed !== "object") return { queries: [], doctrines: [] };

  const queries = Array.isArray(parsed.queries) ? parsed.queries.filter((x) => typeof x === "string") : [];
  const doctrines = Array.isArray(parsed.doctrines) ? parsed.doctrines.filter((x) => typeof x === "string") : [];

  return {
    queries: queries.slice(0, 3),
    doctrines: doctrines.slice(0, 6),
  };
}

/**
 * extractIssueTags({ q, text })
 * Returns: { tags: string[] }
 */
export async function extractIssueTags({ q, text }) {
  const query = typeof q === "string" ? q.trim() : "";
  const src = typeof text === "string" ? text.trim() : "";
  if (!query || !src) return { tags: [] };

  const clipped = src.length > 5000 ? src.slice(0, 5000) : src;

  const prompt = [
    "You are extracting legal issue tags for research organization (not legal advice).",
    "Return STRICT JSON only (no markdown, no commentary).",
    'Schema: { "tags": string[] }',
    "",
    "Rules:",
    "- tags: 3 to 10 short tags max, 1-4 words each.",
    "- Prefer doctrines/issues/procedural posture terms.",
    "",
    `USER_QUERY: ${query}`,
    "",
    "TEXT:",
    clipped,
  ].join("\n");

  const resp = await callOpenAI({
    input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
    maxOutputTokens: 250,
  });

  const textOut = extractOutputText(resp).trim();
  const parsed = safeJsonParse(textOut);

  const tags = Array.isArray(parsed?.tags) ? parsed.tags.filter((x) => typeof x === "string") : [];
  return { tags: tags.slice(0, 10) };
}
