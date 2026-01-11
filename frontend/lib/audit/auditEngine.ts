// frontend/lib/audit/auditEngine.ts
//
// Deterministic audit engine:
// - Categories are a union of strings (AuditCategory)
// - Produces research-only findings with conservative language
// - Uses enforceSafeFinding to prevent prohibited allegation/intent phrasing
//
// Depends on:
//   ../safety/enforceSafeFinding
//   ./categories  (your file with AUDIT_CATEGORIES + CATEGORY_LABELS)

import { enforceSafeFinding } from "../safety/enforceSafeFinding";
import { AUDIT_CATEGORIES, CATEGORY_LABELS } from "./categories";
import type { AuditCategory } from "./categories";

export type Confidence = "low" | "medium" | "high";

export type EvidenceRef = {
  document_id: string;
  chunk_index: number;
  excerpt: string;
};

export type EngineInputChunk = {
  document_id: string;
  chunk_index: number;
  content: string;
};

export type EngineOptions = {
  kind?: string; // e.g. "case_fact_audit"
  maxFindings?: number;
  maxFindingsPerCategory?: number;
  maxEvidencePerFinding?: number;
  excerptMaxChars?: number;
  minScore?: number;
};

export type EngineFinding = {
  kind: string;
  category: AuditCategory;
  title: string;
  severity: "info" | "warning" | "error";
  confidence: Confidence;
  claim: string;
  evidence: EvidenceRef[];
  meta: {
    score: number;
    signals: string[];
    suppressed?: boolean;
    suppressed_reason?: string | null;
  };
};

const DEFAULTS: Required<Omit<EngineOptions, "kind">> = {
  maxFindings: 25,
  maxFindingsPerCategory: 6,
  maxEvidencePerFinding: 3,
  excerptMaxChars: 900,
  minScore: 2,
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function normalizeText(s: string) {
  return (s || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function excerptAround(text: string, matchIndex: number, maxChars: number) {
  const t = text || "";
  if (!t) return "";
  const half = Math.max(80, Math.floor(maxChars / 2));
  const start = Math.max(0, matchIndex - half);
  const end = Math.min(t.length, matchIndex + half);
  return t.slice(start, end).trim();
}

function scoreToConfidence(score: number): Confidence {
  if (score >= 6) return "high";
  if (score >= 3) return "medium";
  return "low";
}

function confidenceToSeverity(conf: Confidence): "info" | "warning" | "error" {
  // Conservative by default. You can promote "high" to "warning".
  if (conf === "high") return "warning";
  return "info";
}

function safeClaim(claim: string) {
  try {
    return { claim: enforceSafeFinding(claim), suppressed: false, reason: null as string | null };
  } catch (e: any) {
    return {
      claim: "Finding text suppressed by safety policy (research-only phrasing required).",
      suppressed: true,
      reason: e?.message || "suppressed",
    };
  }
}

/**
 * Deterministic signals per category.
 * These are "review signals", not accusations.
 */
type SignalDef = { label: string; re: RegExp; score: number };

const SIGNALS: Record<AuditCategory, SignalDef[]> = {
  timeline_consistency: [
    { label: "date_reference", re: /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+\d{4}\b/gi, score: 1 },
    { label: "date_filed", re: /\bdate\s+filed\b|\bfiled\s+on\b/gi, score: 2 },
    { label: "hearing_or_trial", re: /\bhearing\b|\btrial\b|\barraign(?:ment)?\b|\bpretrial\b/gi, score: 1 },
    { label: "continuance", re: /\bcontinuance\b|\badjourn(?:ed|ment)\b/gi, score: 1 },
  ],

  document_completeness: [
    { label: "missing_record", re: /\bmissing\b|\bnot\s+in\s+the\s+record\b|\bno\s+record\b/gi, score: 3 },
    { label: "redacted", re: /\bredact(?:ed|ion)\b/gi, score: 2 },
    { label: "appendix_or_exhibit", re: /\bappendix\b|\bexhibit\b|\battachment\b/gi, score: 1 },
    { label: "unclear_reference", re: /\bunclear\b|\bunknown\b|\bunspecified\b/gi, score: 1 },
  ],

  internal_consistency: [
    { label: "inconsistent_marker", re: /\binconsistent\b|\bcontradict(?:s|ed|ion)\b|\bvaries\b/gi, score: 2 },
    { label: "discrepancy", re: /\bdiscrepanc(?:y|ies)\b|\bmismatch\b|\bconflict\b/gi, score: 2 },
    { label: "different_version", re: /\brevised\b|\bamended\b|\bsupersed(?:e|ed|ing)\b/gi, score: 1 },
  ],

  procedural_signals: [
    { label: "motion", re: /\bmotion\b|\bfiled\s+a\s+motion\b/gi, score: 1 },
    { label: "order", re: /\border\b|\bjudgment\b|\bopinion\b/gi, score: 1 },
    { label: "appeal_or_remand", re: /\bappeal\b|\bappellate\b|\bremand\b/gi, score: 2 },
    { label: "notice_or_service", re: /\bnotice\b|\bserved\b|\bservice\b/gi, score: 1 },
  ],

  citation_traceability: [
    { label: "case_citation_like", re: /\b\d{1,4}\s+[A-Z][A-Za-z.\s]*\s+\d{1,4}\b/g, score: 2 }, // loose reporter-like
    { label: "statute_reference", re: /\bMCL\s+\d+(\.\d+)?\b|\b\d+\s*U\.?\s*S\.?\s*C\.?\s*§?\s*\d+\b/gi, score: 2 },
    { label: "rule_reference", re: /\bMCR\s+\d+(\.\d+)?\b|\bFed\.\s*R\.\s*(Crim|Civ)\.\s*P\.\b/gi, score: 2 },
    { label: "quoted_block", re: /“[^”]{40,}”|"[^"]{40,}"/g, score: 1 },
  ],
};

type Hit = { label: string; score: number; matchIndex: number };

function collectHits(cat: AuditCategory, text: string): Hit[] {
  const defs = SIGNALS[cat] || [];
  const hits: Hit[] = [];

  for (const d of defs) {
    const re = new RegExp(d.re.source, d.re.flags);
    let m: RegExpExecArray | null;

    while ((m = re.exec(text))) {
      hits.push({ label: d.label, score: d.score, matchIndex: m.index });
      if (m.index === re.lastIndex) re.lastIndex++;
      if (hits.length > 40) break;
    }
    if (hits.length > 40) break;
  }
  return hits;
}

function buildResearchClaim(cat: AuditCategory, score: number, signals: string[]) {
  const label = CATEGORY_LABELS[cat];
  const title = label?.title || String(cat);

  // Neutral: "signal", "review", "cross-check"
  const base =
    `Research signal detected for ${title}. ` +
    `Recommended: review the cited excerpts and cross-check against the full record/docket for context and completeness.`;

  const details = signals.length ? ` Signals observed: ${signals.slice(0, 6).join(", ")}.` : "";
  return { title, claim: base + details, score };
}

/**
 * Run the deterministic audit pass over already-materialized chunks.
 */
export function runAuditEngine(input: {
  chunks: EngineInputChunk[];
  categories?: AuditCategory[]; // defaults to all
  options?: EngineOptions;
}): EngineFinding[] {
  const opt = { ...DEFAULTS, ...(input.options || {}) };
  const kind = (input.options?.kind || "case_fact_audit").trim() || "case_fact_audit";
  const excerptMax = clamp(opt.excerptMaxChars, 200, 4000);

  const categories: AuditCategory[] =
    (input.categories && input.categories.length) ? input.categories : [...AUDIT_CATEGORIES];

  const findings: EngineFinding[] = [];
  const perCat = new Map<AuditCategory, number>();

  for (const ch of input.chunks || []) {
    const text = normalizeText(ch.content);
    if (!text) continue;

    for (const cat of categories) {
      const count = perCat.get(cat) || 0;
      if (count >= opt.maxFindingsPerCategory) continue;

      const hits = collectHits(cat, text);
      if (!hits.length) continue;

      const score = hits.reduce((s, h) => s + h.score, 0);
      if (score < opt.minScore) continue;

      const conf = scoreToConfidence(score);
      const severity = confidenceToSeverity(conf);

      const top = hits
        .slice()
        .sort((a, b) => b.score - a.score)
        .slice(0, opt.maxEvidencePerFinding);

      const evidence: EvidenceRef[] = top.map((h) => ({
        document_id: ch.document_id,
        chunk_index: ch.chunk_index,
        excerpt: excerptAround(text, h.matchIndex, excerptMax),
      }));

      const signals = top.map((h) => h.label);
      const draft = buildResearchClaim(cat, score, signals);
      const sc = safeClaim(draft.claim);

      findings.push({
        kind,
        category: cat,
        title: draft.title,
        severity,
        confidence: conf,
        claim: sc.claim,
        evidence,
        meta: {
          score,
          signals,
          suppressed: sc.suppressed,
          suppressed_reason: sc.reason,
        },
      });

      perCat.set(cat, count + 1);
      if (findings.length >= opt.maxFindings) return findings;
    }
  }

  return findings;
}
