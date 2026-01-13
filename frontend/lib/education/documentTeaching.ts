export function deriveTeaching(f: any, ctx?: {
  totalPages?: number;
  totalFindings?: number;
}): string | null {
  const count = Array.isArray(f?.evidence) ? f.evidence.length : 0;
  const title = String(f?.title ?? "").toLowerCase();

  if (title.includes("coverage")) {
    return `This document contains readable text, but some portions may not have been extracted. In records of this type, missing text often corresponds to scanned pages, exhibits, or attachments that require manual review.`;
  }

  if (title.includes("timeline") || title.includes("date")) {
    return count <= 1
      ? `Only ${count || "one"} date was detected in the extracted text. Records of this length typically contain multiple dates (incident, filing, hearings). This suggests parts of the timeline may be missing or unreadable.`
      : `Multiple dates were detected across the document, suggesting a partially reconstructable timeline. Dates should still be cross-checked for omissions.`;
  }

  if (title.includes("money") || title.includes("fee") || title.includes("cost")) {
    return `Monetary amounts were detected in the text. Families should confirm whether these amounts are references, assessments, or final orders, as drafts and summaries often contain outdated figures.`;
  }

  if (title.includes("exhibit") || title.includes("attachment")) {
    return `This document references supporting materials. If those materials are not visible in the extracted text, the record should be treated as partial until the original file is reviewed.`;
  }

  return null;
}

export function attachTeaching(findings: any[], ctx?: any) {
  return findings.map(f => {
    const teaching = deriveTeaching(f, ctx);
    return teaching ? { ...f, teaching } : f;
  });
}
