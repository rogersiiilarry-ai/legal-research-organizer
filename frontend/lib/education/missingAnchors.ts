export function deriveMissingTeaching(f: any): string | null {
  const evidence = Array.isArray(f?.evidence) ? f.evidence : [];
  if (evidence.length > 0) return null;

  return [
    "Missing from the document:",
    "No direct excerpts supporting this finding were detected in the extracted text.",
    "",
    "Why this matters:",
    "When a document does not explicitly state a fact, reviewers treat it as unconfirmed. This does not mean the fact is false, only that it is not clearly documented in the uploaded record."
  ].join("\n");
}
