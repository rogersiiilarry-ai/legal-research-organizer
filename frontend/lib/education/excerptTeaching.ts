export function teachExcerpt(snippet: string) {
  const s = String(snippet ?? "").trim();

  return {
    excerpt: s,
    interpretation:
      "This excerpt is extracted verbatim from the document. It reflects recorded language but does not, by itself, establish accuracy, completeness, or context.",
    readerCheck:
      "Compare this excerpt with surrounding paragraphs or referenced documents to confirm scope, timing, and attribution."
  };
}
