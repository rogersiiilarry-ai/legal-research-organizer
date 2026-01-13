export function explainSnippet(snippet: string): string {
  const s = snippet.toLowerCase();

  if (s.match(/\b(at|around|approximately)\b.*\b(am|pm|\d{2}:\d{2})/)) {
    return "This sentence introduces a time reference. Time anchors are used to establish sequencing, but this excerpt alone does not confirm event order or relation to the charged conduct.";
  }

  if (s.match(/\b(spoke|said|told|reported)\b/)) {
    return "This excerpt reflects a statement or conversation. Statements describe what was said, but do not by themselves confirm accuracy or corroboration.";
  }

  if (s.match(/\b(was|were)\b.*\b(found|located|present)\b/)) {
    return "This language suggests presence or observation, but does not establish causation or responsibility without additional context.";
  }

  return "This excerpt provides factual language from the document, but its significance depends on surrounding context not shown here.";
}
