export function deriveDocumentTeaching(f: any): string | null {
  const evidence = Array.isArray(f?.evidence) ? f.evidence : [];
  const excerpts = evidence
    .map((e: any) => e?.snippet)
    .filter((s: any) => typeof s === "string" && s.length > 25)
    .slice(0, 3);

  if (!excerpts.length) return null;

  const quoted = excerpts.map(s => `• "${s.trim()}"`).join("\n");

  return [
    "Document excerpts:",
    quoted,
    "",
    "Why these excerpts matter:",
    "These passages come directly from the uploaded record. They show what the document explicitly states. Reviewers rely on this language to confirm timelines, identify stated facts, and determine what is documented versus assumed. If a fact does not appear here, it may not be supported by the record."
  ].join("\n");
}
