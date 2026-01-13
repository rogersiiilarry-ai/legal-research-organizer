import { deriveDocumentTeaching } from "./documentAnchors";
import { deriveMissingTeaching } from "./missingAnchors";

export function attachDocumentTeaching(findings: any[]) {
  return findings.map(f => {
    const docTeaching = deriveDocumentTeaching(f);
    const missingTeaching = deriveMissingTeaching(f);

    if (docTeaching) return { ...f, documentTeaching: docTeaching };
    if (missingTeaching) return { ...f, documentTeaching: missingTeaching };
    return f;
  });
}
