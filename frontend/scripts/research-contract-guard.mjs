/**
 * Research Contract Guard (v1)
 * Goal: prevent legal-advice language and legal conclusions from creeping into the codebase.
 *
 * This is a text-level gate. It does NOT "understand" law; it enforces wording discipline.
 *
 * Run: node scripts/research-contract-guard.mjs
 */
import fs from "fs";
import path from "path";

const ROOT = process.cwd();

// Files/directories to scan
const TARGETS = [
  "app/api/audit/export/pdf/route.ts",
  "lib/education",
];

// Hard-forbidden terms (unless you *intend* to quote them from a document; if so, use explicit quoting markers)
const FORBIDDEN = [
  // conclusions / legal judgments
  "guilty",
  "innocent",
  "liable",
  "liability",
  "unlawful",
  "illegal",
  "violated",
  "violation",
  "rights were denied",
  "due process",
  "probable cause", // if you want this only when quoted, keep it here
  "negligence",
  "malpractice",

  // directive legal advice phrasing
  "you should",
  "you must",
  "we recommend",
  "our recommendation",
  "take legal action",
  "sue",
  "lawsuit",
  "file a motion",
  "motion to",
  "appeal",
  "challenge this",
  "argue that",
  "object to",
  "dismiss this",
  "get a lawyer",
  "contact an attorney",
  "legal strategy",
];

// Soft-forbidden: allowed in general English, but often indicates advice. We flag it with a weaker message.
const SOFT = [
  "recommend",
  "should",
  "must",
  "need to",
];

// Allowlist patterns: if a line contains these markers, we treat it as a quote/context (less strict).
// Use these when you genuinely need the term because it appears in the record.
const QUOTE_MARKERS = [
  "Document excerpt:",
  "Document excerpts:",
  "From the document:",
  "Quoted:",
  "Evidence:",
  "Snippet:",
];

function isTextFile(p) {
  return /\.(ts|tsx|js|mjs|json|md|txt)$/i.test(p);
}

function walk(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function loadTargets() {
  const files = [];
  for (const t of TARGETS) {
    const abs = path.join(ROOT, t);
    if (!fs.existsSync(abs)) continue;
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const f of walk(abs)) {
        if (isTextFile(f)) files.push(f);
      }
    } else {
      files.push(abs);
    }
  }
  return files;
}

function containsQuoteMarker(line) {
  const l = line.toLowerCase();
  return QUOTE_MARKERS.some(m => l.includes(m.toLowerCase()));
}

function scanFile(file) {
  const raw = fs.readFileSync(file, "utf8");
  const lines = raw.split(/\r?\n/);

  const findings = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lower = line.toLowerCase();

    // Skip obvious imports to reduce noise
    if (/^\s*import\s/.test(line)) continue;

    // Forbidden checks (strict)
    for (const term of FORBIDDEN) {
      if (lower.includes(term)) {
        // If the line looks like a quote/excerpt section, warn but still flag (your choice)
        const quotedContext = containsQuoteMarker(line);
        findings.push({
          kind: quotedContext ? "WARN_QUOTED" : "ERROR",
          term,
          line: i + 1,
          text: line.trim(),
        });
      }
    }

    // Soft checks
    for (const term of SOFT) {
      if (lower.includes(term)) {
        // Only flag soft terms inside teaching/task strings (common source of accidental advice)
        if (lower.includes("teaching") || lower.includes("reader task") || lower.includes("why this matters")) {
          findings.push({
            kind: "WARN_SOFT",
            term,
            line: i + 1,
            text: line.trim(),
          });
        }
      }
    }
  }

  return findings;
}

function main() {
  const files = loadTargets();

  let hardErrors = 0;
  const report = [];

  for (const f of files) {
    const res = scanFile(f);
    if (!res.length) continue;

    const rel = path.relative(ROOT, f);
    for (const r of res) {
      report.push({ file: rel, ...r });
      if (r.kind === "ERROR") hardErrors++;
    }
  }

  if (report.length) {
    console.log("\n=== Research Contract Guard Report ===\n");
    for (const r of report) {
      const tag = r.kind === "ERROR" ? "ERROR" : "WARN";
      console.log(`[${tag}] ${r.file}:${r.line}  term="${r.term}"`);
      console.log(`       ${r.text}\n`);
    }
  }

  if (hardErrors > 0) {
    console.error(`Research Contract Guard FAILED: ${hardErrors} hard violation(s).`);
    process.exit(1);
  } else {
    console.log("Research Contract Guard PASSED (no hard violations).");
  }
}

main();
