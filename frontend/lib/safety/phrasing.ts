// frontend/lib/safety/phrasing.ts

export type FindingSeverity = "info" | "warning" | "error";

export type AuditCategory =
  | "identity"
  | "timeline"
  | "charges"
  | "procedure"
  | "evidence"
  | "citations"
  | "transcript"
  | "orders"
  | "sentencing"
  | "appeal"
  | "metadata"
  | "unknown";

export type SafeFindingInput = {
  severity: FindingSeverity;
  category: AuditCategory;
  title: string;
  claim: string;
  next_step?: string | null;
};

export type SafeFindingOutput = SafeFindingInput & {
  suppressed: boolean;
  suppressed_reason: string | null;
};

// Key fix: OK branch explicitly has reason?: never
type EnforceOk = { ok: true; claim: string; reason?: never };
type EnforceBad = { ok: false; claim: string; reason: string };
type EnforceResult = EnforceOk | EnforceBad;

const RX = {
  bannedCore:
    /(corrupt|brib|collusion|conspir|cover[- ]?up|falsif|forge|tamper|frame[d]?|misconduct|unlawful|illegal|criminal|fraud|perjur|perjury|extort|kickback|racketeer|plant(?:ed|ing)?|fabricat(?:ed|ing)?|withheld|destroy(?:ed|ing)?|hide|hid|lied|lie|lying|target(?:ed|ing)?|retaliat(?:e|ed|ing)?|bias(?:ed)?|discriminat(?:e|ed|ing)?)/i,

  bannedLegalConclusion:
    /(guilty|innocent|wrongful conviction|malpractice|negligence|due process violation|constitutional violation|miscarriage of justice|probable cause|beyond a reasonable doubt|ineffective assistance|brady|giglio)/i,

  bannedAccusatory:
    /\b(lie|lied|lying|false statement|fabrication|made up)\b/i,
};

export const DISCLAIMERS = {
  short:
    "Research-only: this report summarizes patterns in the provided records and is not legal advice.",
  standard:
    "Research-only: this report summarizes patterns observed in the provided records. It does not make legal conclusions, allegations, or determinations, and it is not legal advice.",
  attorney_handoff:
    "Research-only: prepared to support legal review. Interpretation and next steps should be determined by a licensed attorney.",
} as const;

export const TEMPLATES = {
  timeline_mismatch: (aLabel: string, aDate: string, bLabel: string, bDate: string) =>
    `Timeline discrepancy: ${aLabel} lists ${aDate}, while ${bLabel} lists ${bDate}. This difference should be verified against the source record.`,

  missing_citation: (what: string) =>
    `A citation/reference to ${what} appears in the record, but the referenced material was not located in the reviewed materials.`,

  unsupported_statement: (statementLabel: string, sourceLabel: string) =>
    `${statementLabel} could not be confirmed from ${sourceLabel} within the reviewed materials.`,

  inconsistent_metadata: (field: string, a: string, b: string) =>
    `Inconsistent metadata: ${field} differs across records (${a} vs ${b}).`,

  ambiguous_language: (phrase: string) =>
    `Ambiguous language detected ("${phrase}"). Clarifying context may be needed from surrounding filings or transcripts.`,

  no_chunks: () =>
    "No chunks were found for the target document in the current database. This suggests the document may not have been ingested/chunked yet.",

  ran_ok: (nChunks: number) =>
    `Analysis run executed successfully; ${nChunks} chunk(s) were loaded for review.`,
} as const;

export const NEXT_STEPS = {
  request_missing_exhibit: (exhibitName: string) =>
    `Research task: obtain the referenced ${exhibitName} (or docket attachment) and re-run the audit to confirm alignment.`,

  verify_dates: () =>
    "Research task: verify dates against the original docket entries and any filed-stamp pages.",

  add_transcript: () =>
    "Research task: add relevant transcript pages (or the full transcript) and re-run to improve evidence coverage.",

  compare_versions: () =>
    "Research task: compare available versions of the same filing (if any) and note differences in metadata or text.",

  expand_scope: () =>
    "Research task: include additional related filings (orders, motions, judgments) to validate consistency across the record set.",
} as const;

export function enforceResearchOnlyClaim(claim: string): EnforceResult {
  const c = String(claim || "").trim();

  if (!c) {
    return { ok: false, claim: "Finding text suppressed (empty).", reason: "empty" };
  }

  if (RX.bannedCore.test(c)) {
    return {
      ok: false,
      claim: "Finding text suppressed by safety policy (research-only phrasing required).",
      reason: "banned_core",
    };
  }

  if (RX.bannedLegalConclusion.test(c)) {
    return {
      ok: false,
      claim: "Finding text suppressed by safety policy (avoid legal conclusions; use record-based wording).",
      reason: "banned_legal_conclusion",
    };
  }

  if (RX.bannedAccusatory.test(c)) {
    return {
      ok: false,
      claim: "Finding text suppressed by safety policy (avoid accusatory language; use 'inconsistent' / 'not confirmed').",
      reason: "banned_accusatory",
    };
  }

  return { ok: true, claim: c };
}

export function makeSafeFinding(input: SafeFindingInput): SafeFindingOutput {
  const title = String(input.title || "").trim() || "Finding";
  const next_step = input.next_step ? String(input.next_step).trim() : null;

  const res = enforceResearchOnlyClaim(input.claim);

  if (res.ok) {
    return {
      ...input,
      title,
      claim: res.claim,
      next_step,
      suppressed: false,
      suppressed_reason: null,
    };
  }

  // res is EnforceBad here, reason is safe
  return {
    ...input,
    title,
    claim: res.claim,
    next_step,
    suppressed: true,
    suppressed_reason: res.reason,
  };
}

export function safeClaimString(claim: string): {
  claim: string;
  suppressed: boolean;
  reason: string | null;
} {
  const res = enforceResearchOnlyClaim(claim);

  if (res.ok) {
    return { claim: res.claim, suppressed: false, reason: null };
  }

  return { claim: res.claim, suppressed: true, reason: res.reason };
}
