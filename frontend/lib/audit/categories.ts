export const AUDIT_CATEGORIES = [
  "timeline_consistency",
  "document_completeness",
  "internal_consistency",
  "procedural_signals",
  "citation_traceability",
] as const;

export type AuditCategory = typeof AUDIT_CATEGORIES[number];

export const CATEGORY_LABELS: Record<AuditCategory, {
  title: string;
  description: string;
}> = {
  timeline_consistency: {
    title: "Timeline Consistency",
    description: "Checks date order, gaps, and sequence alignment across filings and orders."
  },
  document_completeness: {
    title: "Document Completeness",
    description: "Identifies referenced exhibits, motions, or attachments that are not present."
  },
  internal_consistency: {
    title: "Internal Consistency",
    description: "Flags mismatches in names, case numbers, counts, and statute references."
  },
  procedural_signals: {
    title: "Procedural Signals",
    description: "Surfaces notable procedural patterns such as delays or repeated continuances."
  },
  citation_traceability: {
    title: "Citation Traceability",
    description: "Verifies that claims and references are supported by cited record material."
  },
};
