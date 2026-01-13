import { explainSnippet } from "./snippetExplainer";

export function attachSnippetTeaching(findings: any[]) {
  return findings.map(f => {
    const ev = Array.isArray(f.evidence) ? f.evidence : [];

    const explained = ev.map(e => {
      if (!e?.snippet) return e;
      return {
        ...e,
        explanation: explainSnippet(e.snippet)
      };
    });

    return { ...f, evidence: explained };
  });
}
