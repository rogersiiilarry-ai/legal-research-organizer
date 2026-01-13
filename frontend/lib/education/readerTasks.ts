export function deriveReaderTask(f: any): string | null {
  const title = String(f?.title ?? "").toLowerCase();

  if (title.includes("coverage")) {
    return "Reader task: Verify whether the original PDF contains scanned pages or exhibits not captured here. If so, review those pages manually before relying on downstream findings.";
  }

  if (title.includes("timeline")) {
    return "Reader task: Compare these dates against the charging document, police report, or affidavit to confirm whether any gaps or inconsistencies exist.";
  }

  if (title.includes("metadata")) {
    return "Reader task: Check the document header/footer or docket sheet to confirm case number, court, and party names.";
  }

  if (title.includes("money") || title.includes("fees")) {
    return "Reader task: Look for an order, judgment, or sentencing page that explicitly states assessed or ordered amounts.";
  }

  if (title.includes("exhibit")) {
    return "Reader task: Determine whether an exhibit list or attachment index exists outside the extracted text.";
  }

  return null;
}
