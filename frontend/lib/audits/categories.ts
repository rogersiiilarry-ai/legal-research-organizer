// frontend/lib/audits/categories.ts
// v1 audit taxonomy for research-only legal record review.
// Keep everything framed as "record signals" (no intent, no allegations).

export type AuditCategoryId =
  | "record_consistency"
  | "timeline_gaps"
  | "citation_coverage"
  | "procedural_alignment"
  | "evidence_referencing"
  | "charge_elements"
  | "sentence_calculation"
  | "standard_of_review";

export type JurisdictionScope =
  | "general"
  | "mi_state"
  | "mi_federal"
  | "mi_local"
  | "unknown";

export type AuditSeverity = "info" | "warning" | "critical";

export type AuditCategory = {
  id: AuditCategoryId;
  title: string;
  description: string;

  /**
   * Optional: UI grouping + sorting.
   */
  group:
    | "Record Integrity"
    | "Legal Support"
    | "Procedure"
    | "Evidence"
    | "Substantive"
    | "Sentencing"
    | "Appellate";

  /**
   * Helps you gate categories by market/jurisdiction later without rewriting code.
   */
  jurisdiction: JurisdictionScope[];

  /**
   * Used to keep “results” language safe: a category only produces neutral “signals.”
   */
  outputMode: "signals_only";

  /**
   * Default severity level for findings produced by this category.
   * Individual findings can override.
   */
  defaultSeverity: AuditSeverity;

  /**
   * Prompt-style guidance your analysis runner can use when generating findings.
   * Not shown to users directly.
   */
  guidance: {
    focus: string[];
    avoid: string[];
    allowedPhrasing: string[];
  };
};

export const AUDIT_CATEGORIES: Record<AuditCategoryId, AuditCategory> = {
  record_consistency: {
    id: "record_consistency",
    title: "Record consistency",
    description:
      "Checks for internal consistency across the record (names, counts, dates, docket numbers, charges, statutes). Flags contradictions and mismatches as research signals.",
    group: "Record Integrity",
    jurisdiction: ["general", "mi_state", "mi_federal", "mi_local", "unknown"],
    outputMode: "signals_only",
    defaultSeverity: "warning",
    guidance: {
      focus: [
        "Conflicting dates (arrest, arraignment, trial, sentencing, filing)",
        "Inconsistent party names / identifiers",
        "Docket number mismatches",
        "Counts/charges described differently across sections",
        "Statute citations inconsistent across the opinion/record",
      ],
      avoid: [
        "Any allegation of wrongdoing or intent",
        "Any conclusion that a court or party acted improperly",
        "Terms like 'corrupt', 'bribery', 'fraud', 'misconduct'",
      ],
      allowedPhrasing: [
        "The record contains inconsistent references to …",
        "Two sections describe … differently",
        "A mismatch appears between … and …",
        "This item may warrant follow-up review",
      ],
    },
  },

  timeline_gaps: {
    id: "timeline_gaps",
    title: "Timeline gaps",
    description:
      "Identifies missing or unclear intervals in the procedural timeline (e.g., long gaps between key events, absent dates for referenced actions).",
    group: "Record Integrity",
    jurisdiction: ["general", "mi_state", "mi_federal", "mi_local", "unknown"],
    outputMode: "signals_only",
    defaultSeverity: "info",
    guidance: {
      focus: [
        "Events referenced without dates",
        "Large gaps between dated events",
        "Procedural steps referenced but not placed on a timeline",
        "Sequence ambiguity (what happened first)",
      ],
      avoid: [
        "Speculating why a gap exists",
        "Claiming evidence was withheld or hidden",
        "Implying deliberate delay or intent",
      ],
      allowedPhrasing: [
        "The timeline is unclear regarding …",
        "A date was not located for …",
        "There is a gap between … and … in the available record",
        "The sequence of events may require additional documentation",
      ],
    },
  },

  citation_coverage: {
    id: "citation_coverage",
    title: "Citation coverage",
    description:
      "Maps which legal propositions are supported by citations and flags unsupported or weakly supported propositions as research signals (not conclusions).",
    group: "Legal Support",
    jurisdiction: ["general", "mi_state", "mi_federal", "unknown"],
    outputMode: "signals_only",
    defaultSeverity: "warning",
    guidance: {
      focus: [
        "Key legal statements without authority nearby",
        "Standards/tests stated without citation",
        "Factual assertions presented as background without sourcing (where applicable)",
        "Overreliance on string cites without analysis (flag as 'limited explanation')",
      ],
      avoid: [
        "Saying a judge 'ignored' law",
        "Calling citations 'fake' or 'fabricated'",
        "Accusations like 'cover-up' or 'collusion'",
      ],
      allowedPhrasing: [
        "A supporting citation was not located near this statement",
        "This proposition may benefit from additional authority",
        "The record does not indicate the basis for … in this excerpt",
        "The reasoning is summarized; additional analysis may exist outside this excerpt",
      ],
    },
  },

  procedural_alignment: {
    id: "procedural_alignment",
    title: "Procedural alignment",
    description:
      "Checks whether commonly expected procedural steps are documented (hearings, notices, waivers, advisements) and flags missing/unclear documentation.",
    group: "Procedure",
    jurisdiction: ["general", "mi_state", "mi_federal", "mi_local", "unknown"],
    outputMode: "signals_only",
    defaultSeverity: "warning",
    guidance: {
      focus: [
        "Mentions of hearings without transcript/summary",
        "Waiver/consent referenced without explanation",
        "Deadlines referenced without dates",
        "Unclear preservation (objection/motion) markers",
      ],
      avoid: [
        "Claiming procedure was violated",
        "Claiming rights were denied as a conclusion",
        "Naming individuals as responsible",
      ],
      allowedPhrasing: [
        "The record excerpt does not indicate whether … occurred",
        "Documentation for … was not located in the provided materials",
        "This procedural step is referenced but not described here",
        "Further record review may clarify this point",
      ],
    },
  },

  evidence_referencing: {
    id: "evidence_referencing",
    title: "Evidence referencing",
    description:
      "Flags references to exhibits, reports, videos, lab results, or testimony that are not included or not clearly connected within the provided record.",
    group: "Evidence",
    jurisdiction: ["general", "mi_state", "mi_federal", "mi_local", "unknown"],
    outputMode: "signals_only",
    defaultSeverity: "warning",
    guidance: {
      focus: [
        "Exhibits mentioned but not described",
        "Evidence referenced without foundation in the excerpt",
        "Unclear chain of references (who said what, where, when)",
        "Key evidence summaries without a pointer to the underlying item",
      ],
      avoid: [
        "Claiming evidence was planted/tampered with",
        "Saying testimony was false or fabricated",
        "Implying intent",
      ],
      allowedPhrasing: [
        "This excerpt references an exhibit not included here",
        "The underlying document/item is not present in the provided materials",
        "The record excerpt does not specify …",
        "Additional source material may be needed to evaluate this reference",
      ],
    },
  },

  charge_elements: {
    id: "charge_elements",
    title: "Charge elements mapping",
    description:
      "Maps charged offenses to commonly stated elements (as described in the record) and flags where the record excerpt does not clearly connect facts to elements.",
    group: "Substantive",
    jurisdiction: ["mi_state", "mi_federal", "general", "unknown"],
    outputMode: "signals_only",
    defaultSeverity: "info",
    guidance: {
      focus: [
        "Offense named but elements not summarized",
        "Elements summarized but factual linkage unclear in excerpt",
        "Multiple counts with unclear differentiation",
      ],
      avoid: [
        "Saying the evidence is insufficient as a conclusion",
        "Saying 'wrongfully convicted' or similar",
      ],
      allowedPhrasing: [
        "The excerpt does not describe how facts were linked to each element",
        "Elements are referenced but not enumerated in this portion of the record",
        "Count differentiation is not clear in the provided excerpt",
        "A full record review may be required for element-by-element mapping",
      ],
    },
  },

  sentence_calculation: {
    id: "sentence_calculation",
    title: "Sentencing consistency",
    description:
      "Checks whether sentencing references (guidelines, scoring variables, enhancements, credit time) appear consistent within the record and flags unclear/missing detail.",
    group: "Sentencing",
    jurisdiction: ["mi_state", "mi_federal", "unknown"],
    outputMode: "signals_only",
    defaultSeverity: "warning",
    guidance: {
      focus: [
        "Guidelines mentioned without scores shown",
        "Enhancements referenced without basis in excerpt",
        "Credit time referenced without calculation detail",
        "Sentence components unclear (min/max, concurrent/consecutive)",
      ],
      avoid: [
        "Claiming the sentence is illegal as a conclusion",
        "Accusing manipulation of scoring",
      ],
      allowedPhrasing: [
        "The basis for this scoring/enhancement is not described in the excerpt",
        "A calculation detail was not located in the provided materials",
        "The record excerpt is unclear on whether sentences are concurrent or consecutive",
        "Additional sentencing documents may clarify this point",
      ],
    },
  },

  standard_of_review: {
    id: "standard_of_review",
    title: "Appellate framing (standard of review)",
    description:
      "Identifies the stated standard of review and flags issues where the excerpt does not clearly state the standard or apply it explicitly.",
    group: "Appellate",
    jurisdiction: ["mi_state", "mi_federal", "general", "unknown"],
    outputMode: "signals_only",
    defaultSeverity: "info",
    guidance: {
      focus: [
        "Standard of review missing for an issue",
        "Standard stated but application not clear in excerpt",
        "Multiple issues with inconsistent framing",
      ],
      avoid: [
        "Calling the court biased or improper",
        "Accusing intentional misapplication",
      ],
      allowedPhrasing: [
        "A standard of review was not located in this excerpt for the referenced issue",
        "The application of the standard is summarized; full analysis may exist elsewhere",
        "Issue framing could be clarified with additional record context",
      ],
    },
  },
};

/**
 * Defaults for UI lists and validation.
 */
export const AUDIT_CATEGORY_LIST: AuditCategory[] = Object.values(AUDIT_CATEGORIES);

/**
 * Helper: validate a string and return a category id or null.
 */
export function asAuditCategoryId(v: any): AuditCategoryId | null {
  if (typeof v !== "string") return null;
  const s = v.trim() as AuditCategoryId;
  return s && (s in AUDIT_CATEGORIES) ? s : null;
}

/**
 * Helper: safe default.
 */
export function normalizeAuditCategoryId(v: any, fallback: AuditCategoryId = "record_consistency") {
  return asAuditCategoryId(v) ?? fallback;
}
