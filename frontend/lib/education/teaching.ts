function num(x: any, fallback = 0) {
  const n = typeof x === "number" ? x : parseFloat(String(x ?? ""));
  return Number.isFinite(n) ? n : fallback;
}

function pickStr(...vals: any[]): string {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function evidenceCount(e: any): number {
  if (!e) return 0;
  if (Array.isArray(e)) return e.length;
  if (typeof e === "object") return Object.keys(e).length;
  return 0;
}

function chunkCountFromFinding(f: any): number {
  return num(f?.chunk_count ?? f?.coverage?.chunk_count ?? f?.meta?.chunk_count, 0);
}

function statementEstimateFromFinding(f: any): number {
  return num(f?.statement_estimate ?? f?.coverage?.statement_estimate ?? f?.meta?.statement_estimate, 0);
}

function detectedCountFromFinding(f: any): number {
  // Common fields you’ve emitted in findings/evidence
  return num(
    f?.detected_count,
    f?.count,
    f?.meta?.count,
    f?.signals?.count,
    0
  );
}

export function teachFinding(f: any): { teaching?: string; research_followup?: string } {
  const title = pickStr(f?.title, f?.name, "");
  const t = title.toLowerCase();

  const ecount = evidenceCount(f?.evidence);
  const chunks = chunkCountFromFinding(f);
  const est    = statementEstimateFromFinding(f);
  const dcnt   = detectedCountFromFinding(f);

  // Heuristic “strength” buckets
  const weakEvidence = ecount <= 1;
  const lowCoverage  = chunks > 0 && chunks <= 2 || (est > 0 && est < 80);
  const thinSignals  = dcnt > 0 && dcnt <= 2;

  // COVERAGE
  if (t.includes("coverage")) {
    const teaching =
      "Coverage is a proxy for how much text was actually extracted and readable. " +
      "Coverage limits confidence: if extraction is partial, downstream findings may be incomplete.";

    const follow =
      (lowCoverage || weakEvidence)
        ? "Research follow-up: Coverage seems low/thin. Confirm whether the PDF is scanned, whether exhibits/attachments exist, and consider enabling OCR before relying on downstream findings."
        : "Research follow-up: Coverage appears adequate. Next, confirm whether exhibits/attachments were included and whether any pages were excluded from extraction.";

    return { teaching, research_followup: follow };
  }

  // GAPS / MISSING MATERIAL
  if (t.includes("gap") || t.includes("missing")) {
    const teaching =
      "Coverage gaps mean the system can only evaluate extracted text. Scanned pages, images, and exhibits may be invisible unless OCR or native text is available.";

    const follow =
      "Research follow-up: Check if the source packet includes exhibits, photos, screenshots, or scanned pages. If yes, rerun with OCR or upload the native-text version to reduce blind spots.";

    return { teaching, research_followup: follow };
  }

  // METADATA
  if (t.includes("metadata") || t.includes("case")) {
    const teaching =
      "Metadata signals confirm identity/context (who/what/where). If metadata is weak, avoid over-attribution and treat roles/case identifiers as provisional.";

    const follow =
      weakEvidence
        ? "Research follow-up: Look for a caption block, docket header/footer, judge/court line, or case number on the first pages. If missing in extracted text, treat identity attribution as provisional."
        : "Research follow-up: Cross-check detected identifiers against headers/footers and any docket labels to confirm the correct case and parties.";

    return { teaching, research_followup: follow };
  }

  // TIMELINE
  if (t.includes("timeline") || t.includes("date")) {
    const teaching =
      "Timeline signals anchor events to dates. With only a few detected dates, ordering and missing intervals are common risks.";

    const follow =
      (thinSignals || weakEvidence)
        ? "Research follow-up: Only a small number of date anchors were detected. Compare to incident date, filing date, and hearing dates. Check for missing sections (e.g., incident narrative vs. procedural timeline)."
        : "Research follow-up: Compare detected dates to filing/hearing/incident dates and verify ordering. Flag any gaps where events are referenced without dates.";

    return { teaching, research_followup: follow };
  }

  // MONEY
  if (t.includes("fees") || t.includes("money") || t.includes("cost")) {
    const teaching =
      "Money references may indicate fees, fines, restitution, bonds, or administrative costs. Treat amounts as mentions unless the document explicitly labels them as assessed/ordered/paid/balance.";

    const follow =
      weakEvidence
        ? "Research follow-up: If amounts are expected but not detected, check for fee tables, receipts, or clerk summaries that may be scanned images. If amounts appear, capture the labeled context (assessed vs paid vs balance)."
        : "Research follow-up: When an amount appears, capture the label context (assessed/ordered/paid/balance) and confirm whether it’s fees vs restitution vs bond.";

    return { teaching, research_followup: follow };
  }

  // EXHIBITS
  if (t.includes("exhibit") || t.includes("attachment")) {
    const teaching =
      "Exhibits/attachments often carry the strongest evidence. If exhibits are missing or not extracted, treat the record as partial and separate extracted-text claims from what the full file may show.";

    const follow =
      "Research follow-up: Confirm whether exhibits/attachments exist in the source packet. If not present in extracted text, treat them as coverage-limiting evidence and seek the exhibit index or docket attachment list.";

    return { teaching, research_followup: follow };
  }

  return {};
}

export function addTeachingToFindings(findings: any[]): any[] {
  if (!Array.isArray(findings)) return [];
  return findings.map((f) => {
    const { teaching, research_followup } = teachFinding(f);
    const out = { ...f };
    if (teaching) out.teaching = teaching;
    if (research_followup) out.research_followup = research_followup;
    return out;
  });
}
