export function attachEvidenceStatus(findings: any[]) {
  return (Array.isArray(findings) ? findings : []).map((f) => {
    const ev = Array.isArray((f as any)?.evidence) ? (f as any).evidence : [];
    const snippets = ev
      .map((e: any) => e?.snippet)
      .filter((s: any) => typeof s === "string" && s.length > 30);

    let evidenceStatus: "explicit" | "implied" | "missing" = "missing";
    if (snippets.length > 0) evidenceStatus = "explicit";
    else if (String((f as any)?.what_it_means || "").trim().length > 0) evidenceStatus = "implied";

    let confidence: "high" | "medium" | "low" = "low";
    if (evidenceStatus === "explicit") confidence = "high";
    else if (evidenceStatus === "implied") confidence = "medium";

    return { ...(f as any), evidenceStatus, confidence, anchorQuote: snippets[0] ?? null };
  });
}
