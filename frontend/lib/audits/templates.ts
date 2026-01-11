// frontend/lib/audits/templates.ts
// Neutral, research-only finding templates tied to categories.
// Produces consistent output structure for UI + exports.

import type { AuditCategoryId, AuditSeverity } from "./categories";
import { AUDIT_CATEGORIES } from "./categories";

export type EvidenceRef = {
  document_id: string;
  chunk_index: number;
  excerpt: string;
};

export type AuditFinding = {
  kind: "case_fact_audit";
  category: AuditCategoryId;
  severity: AuditSeverity;
  title: string;
  claim: string; // must pass enforceSafeFinding upstream
  questions: string[]; // follow-up prompts for user/lawyer
  suggestedNextDocs: string[]; // names/types of docs to obtain
  evidence: EvidenceRef[];
  meta?: Record<string, any>;
};

function uniq(arr: string[]) {
  return Array.from(new Set(arr.map((s) => s.trim()).filter(Boolean)));
}

export function buildFinding(args: {
  category: AuditCategoryId;
  title: string;
  claim: string;
  severity?: AuditSeverity;
  evidence?: EvidenceRef[];
  questions?: string[];
  suggestedNextDocs?: string[];
  meta?: Record<string, any>;
}): AuditFinding {
  const cat = AUDIT_CATEGORIES[args.category];

  return {
    kind: "case_fact_audit",
    category: args.category,
    severity: args.severity ?? cat.defaultSeverity,
    title: args.title,
    claim: args.claim,
    questions: uniq(args.questions ?? []),
    suggestedNextDocs: uniq(args.suggestedNextDocs ?? []),
    evidence: args.evidence ?? [],
    meta: args.meta ?? {},
  };
}

/**
 * Prebuilt templates (useful for v1 MVP).
 * Your analysis runner can pick one, then fill in specifics.
 */
export const FINDING_TEMPLATES: Record<
  AuditCategoryId,
  Array<{
    title: string;
    severity?: AuditSeverity;
    claim: (vars: Record<string, string>) => string;
    questions: (vars: Record<string, string>) => string[];
    suggestedNextDocs: string[];
  }>
> = {
  record_consistency: [
    {
      title: "Inconsistent identifiers in the record",
      severity: "warning",
      claim: (v) =>
        `The record contains inconsistent references to ${v.field || "a key identifier"} across sections (e.g., ${v.a || "version A"} vs. ${v.b || "version B"}).`,
      questions: (v) => [
        `Where is ${v.field || "this identifier"} defined as authoritative (caption, register of actions, judgment)?`,
        "Is the difference explained elsewhere in the record (amended filing, corrected order)?",
      ],
      suggestedNextDocs: [
        "Register of Actions / Docket Sheet",
        "Judgment of Sentence / Final Order",
        "Charging Instrument (Information/Indictment/Complaint)",
      ],
    },
    {
      title: "Potential contradiction between sections",
      severity: "warning",
      claim: (v) =>
        `Two sections describe ${v.topic || "a key fact"} differently, and the excerpt does not indicate which description controls.`,
      questions: () => [
        "Is there an amended opinion/order that clarifies the disputed point?",
        "Do transcripts or exhibits resolve the inconsistency?",
      ],
      suggestedNextDocs: [
        "Trial Transcript (relevant day)",
        "Sentencing Transcript",
        "Amended Order / Opinion (if any)",
      ],
    },
  ],

  timeline_gaps: [
    {
      title: "Timeline detail missing for a referenced event",
      severity: "info",
      claim: (v) =>
        `A date or sequence detail was not located in the provided excerpt for ${v.event || "a referenced event"}, which leaves the timeline unclear.`,
      questions: () => [
        "What is the earliest and latest date this event could have occurred based on the docket?",
        "Is the event described in a separate filing or transcript?",
      ],
      suggestedNextDocs: ["Register of Actions / Docket Sheet", "Hearing Transcript", "Motion / Notice associated with the event"],
    },
    {
      title: "Large interval between recorded events",
      severity: "info",
      claim: (v) =>
        `There appears to be a gap between ${v.start || "Event A"} and ${v.end || "Event B"} in the available record; additional context may exist outside this excerpt.`,
      questions: () => [
        "Are there filings or hearings during the gap that are not included here?",
        "Does the docket show continuances or scheduling orders?",
      ],
      suggestedNextDocs: ["Register of Actions / Docket Sheet", "Scheduling/Adjournment Orders"],
    },
  ],

  citation_coverage: [
    {
      title: "Legal proposition stated without nearby authority",
      severity: "warning",
      claim: (v) =>
        `A supporting citation was not located near the statement about ${v.proposition || "a legal proposition"} in the provided excerpt.`,
      questions: () => [
        "Is the authority cited earlier/later in the opinion or in a related motion brief?",
        "Is there controlling Michigan or federal authority that typically supports this proposition?",
      ],
      suggestedNextDocs: ["Full Opinion Text", "Appellate Briefs (if available)", "Trial Court Order referenced in the opinion"],
    },
  ],

  procedural_alignment: [
    {
      title: "Referenced procedural step not documented in excerpt",
      severity: "warning",
      claim: (v) =>
        `The record excerpt references ${v.step || "a procedural step"} but does not indicate whether it occurred or how it was documented.`,
      questions: () => [
        "Is there a transcript, minute entry, or order confirming the step?",
        "Is there a waiver/notice form associated with the step?",
      ],
      suggestedNextDocs: ["Minute Entry / Hearing Notice", "Order/Transcript for the referenced step", "Waiver/Advisement Form (if applicable)"],
    },
  ],

  evidence_referencing: [
    {
      title: "Referenced exhibit not present in provided materials",
      severity: "warning",
      claim: (v) =>
        `This excerpt references ${v.exhibit || "an exhibit"} that is not included here; evaluating the reference may require obtaining the underlying item.`,
      questions: () => [
        "Is the exhibit filed electronically or only available from the trial court clerk?",
        "Does the opinion describe the exhibit contents in a separate section?",
      ],
      suggestedNextDocs: ["Exhibit List", "Referenced Exhibit (PDF/media)", "Transcript segment describing the exhibit"],
    },
  ],

  charge_elements: [
    {
      title: "Element-to-fact linkage not explicit in excerpt",
      severity: "info",
      claim: (v) =>
        `The excerpt does not describe how the facts were linked to the elements of ${v.charge || "the charged offense"}; additional record context may be required for mapping.`,
      questions: () => [
        "Where does the record summarize the elements applied (jury instructions, trial court ruling)?",
        "Are there separate counts requiring separate element mapping?",
      ],
      suggestedNextDocs: ["Jury Instructions (final)", "Trial Court Opinion/Order on motions", "Charging Instrument (counts & statutes)"],
    },
  ],

  sentence_calculation: [
    {
      title: "Sentencing detail unclear in excerpt",
      severity: "warning",
      claim: (v) =>
        `The basis for ${v.item || "a sentencing component"} is not described in the provided excerpt; additional sentencing documentation may clarify this point.`,
      questions: () => [
        "Does the sentencing transcript explain the scoring or rationale?",
        "Is there a sentencing information report or guidelines worksheet referenced?",
      ],
      suggestedNextDocs: ["Sentencing Transcript", "Sentencing Information Report / Guidelines Worksheet", "Judgment of Sentence"],
    },
  ],

  standard_of_review: [
    {
      title: "Standard of review not clearly stated for an issue",
      severity: "info",
      claim: (v) =>
        `A standard of review was not located in this excerpt for the issue concerning ${v.issue || "the referenced issue"}; the full analysis may be elsewhere in the opinion.`,
      questions: () => [
        "Is the standard stated earlier in the opinion's issue-by-issue structure?",
        "Is the issue framed differently in the briefs or trial court order?",
      ],
      suggestedNextDocs: ["Full Opinion Text", "Appellate Briefs", "Trial Court Order referenced"],
    },
  ],
};

/**
 * Pick a template safely.
 */
export function pickTemplate(category: AuditCategoryId, index = 0) {
  const arr = FINDING_TEMPLATES[category] ?? [];
  return arr[Math.max(0, Math.min(index, arr.length - 1))] ?? null;
}
