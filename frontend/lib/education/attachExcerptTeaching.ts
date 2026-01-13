import { teachExcerpt } from "./excerptTeaching";

export function attachExcerptTeaching(findings: any[]) {
  return findings.map(f => {
    if (!Array.isArray(f?.evidence)) return f;

    const evidence = f.evidence.map((e: any) => {
      if (!e?.snippet) return e;

      return {
        ...e,
        excerptTeaching: teachExcerpt(e.snippet)
      };
    });

    return { ...f, evidence };
  });
}
