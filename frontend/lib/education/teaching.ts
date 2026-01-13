type NumLike = number | string | null | undefined;

function toNum(v: NumLike): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Returns the first finite number found in the provided values.
 * If none are found, returns `fallback` (default 0).
 */
export function coalesceNumber(values: NumLike[], fallback = 0): number {
  for (const v of values) {
    const n = toNum(v);
    if (n != null) return n;
  }
  return fallback;
}

/**
 * Attach a research-safe teaching note to each finding.
 * Keeps language strictly "research / record / extracted text" and avoids legal advice framing.
 */
export function attachTeaching(findings: any[]) {
  return (findings || []).map((f: any) => {
    const severity = String(f?.severity || "").toLowerCase();

    const count = coalesceNumber(
      [
        f?.detected_count,
        f?.count,
        f?.meta?.count,
        f?.signals?.count,
      ],
      0
    );

    const base =
      "Research note: This finding summarizes patterns detected in extracted record text. " +
      "It may reflect omissions, ambiguity, or transcription artifacts. Validate against the source document(s).";

    const sevNote =
      severity === "high"
        ? "Priority: review promptly and confirm with the original record."
        : severity === "medium"
          ? "Review: confirm by checking the cited excerpts in context."
          : "Review: verify in context if this point matters to your question.";

    const countNote =
      count > 0
        ? `Signals observed: ${count}.`
        : "";

    return {
      ...f,
      teaching: [base, sevNote, countNote].filter(Boolean).join(" "),
    };
  });
}

// Back-compat alias (older callers)
export const addTeachingToFindings = attachTeaching;

