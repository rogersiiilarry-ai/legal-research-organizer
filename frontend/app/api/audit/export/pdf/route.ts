// frontend/app/api/audit/export/pdf/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { PDFDocument, StandardFonts, rgb, degrees } from "pdf-lib";

export const runtime = "nodejs";

/* -------------------------------- helpers -------------------------------- */

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function safeStr(v: any, max = 8000) {
  if (typeof v !== "string") return "";
  const s = v.trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max) : s;
}

function toBool(v: any) {
  return v === true || v === "true" || v === 1 || v === "1";
}

function normalizeTier(v: any): "basic" | "pro" {
  const t = safeStr(v, 20).toLowerCase();
  return t === "pro" ? "pro" : "basic";
}

/* ---------------------------------- auth --------------------------------- */

type Auth =
  | { ok: true; mode: "system"; userId: null }
  | { ok: true; mode: "user"; userId: string }
  | { ok: false; status: number; error: string };

async function requireSystemOrUser(req: Request): Promise<Auth> {
  const provided = req.headers.get("x-ingest-secret") || "";
  const expected = process.env.INGEST_SECRET || "";

  if (expected && provided && provided === expected) {
    return { ok: true, mode: "system", userId: null };
  }

  const cookieStore = cookies();
  const supabaseAuth = createServerClient(
    mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
    mustEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        set() {},
        remove() {},
      },
    }
  );

  const { data, error } = await supabaseAuth.auth.getUser();
  if (error || !data?.user?.id) return { ok: false, status: 401, error: "Unauthorized" };
  return { ok: true, mode: "user", userId: data.user.id };
}

function isAdminAllowlist(userId: string | null) {
  if (!userId) return false;
  const raw = process.env.ADMIN_USER_IDS || "";
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.includes(userId);
}

type DbEntitlement = { isAdmin: boolean; freeAccess: boolean; freeTier: "basic" | "pro" | null };

async function tryGetDbEntitlement(supabase: any, userId: string): Promise<DbEntitlement> {
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("is_admin, free_access, free_tier")
      .eq("id", userId)
      .maybeSingle();

    if (error || !data) return { isAdmin: false, freeAccess: false, freeTier: null };

    const isAdmin = toBool((data as any).is_admin);
    const freeAccess = toBool((data as any).free_access);
    const ft = safeStr((data as any).free_tier, 20).toLowerCase();
    const freeTier = ft === "pro" ? "pro" : ft === "basic" ? "basic" : null;

    return { isAdmin, freeAccess, freeTier };
  } catch {
    return { isAdmin: false, freeAccess: false, freeTier: null };
  }
}

function resolveAccess(input: {
  authMode: "system" | "user";
  userId: string | null;
  analysisMeta: any;
  dbEntitlement: DbEntitlement | null;
}) {
  const { authMode, userId, analysisMeta, dbEntitlement } = input;

  if (authMode === "system") {
    const tier = normalizeTier(analysisMeta?.tier);
    return { allowed: true, tier, isAdmin: true, exportAllowed: tier === "pro" };
  }

  const allowlistAdmin = isAdminAllowlist(userId);
  const dbAdmin = !!dbEntitlement?.isAdmin;
  const isAdmin = allowlistAdmin || dbAdmin;

  if (isAdmin) {
    return { allowed: true, tier: "pro" as const, isAdmin: true, exportAllowed: true };
  }

  if (dbEntitlement?.freeAccess) {
    const tier = dbEntitlement.freeTier || "basic";
    return { allowed: true, tier, isAdmin: false, exportAllowed: tier === "pro" };
  }

  const paid = !!analysisMeta?.paid;
  if (!paid) return { allowed: false, tier: "basic" as const, isAdmin: false, exportAllowed: false, reason: "PAYMENT_REQUIRED" };

  const tier = normalizeTier(analysisMeta?.tier);
  return { allowed: true, tier, isAdmin: false, exportAllowed: tier === "pro" };
}

/* ------------------------------ pdf rendering ----------------------------- */

const PAGE_W = 612; // 8.5in * 72
const PAGE_H = 792; // 11in * 72
const MARGIN = 54; // 0.75in

type Fonts = { regular: any; bold: any; mono: any };

function fmtDate(iso: string) {
  try {
    return new Date(iso).toISOString().replace("T", " ").replace("Z", " UTC");
  } catch {
    return iso || "";
  }
}

function severityLabel(s: any) {
  const t = safeStr(String(s || ""), 20).toLowerCase();
  if (t === "high" || t === "critical") return "High";
  if (t === "warn" || t === "warning") return "Warning";
  if (t === "info") return "Info";
  return t ? t[0].toUpperCase() + t.slice(1) : "Info";
}

function severityColor(s: any) {
  const t = safeStr(String(s || ""), 20).toLowerCase();
  if (t === "high" || t === "critical") return rgb(0.78, 0.18, 0.18);
  if (t === "warn" || t === "warning") return rgb(0.72, 0.45, 0.10);
  return rgb(0.12, 0.46, 0.72);
}

function wrapLines(text: string, font: any, fontSize: number, maxWidth: number) {
  const raw = safeStr(text, 100000);
  if (!raw) return [""];
  const words = raw.replace(/\s+/g, " ").split(" ");
  const lines: string[] = [];
  let line = "";

  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    const width = font.widthOfTextAtSize(next, fontSize);
    if (width <= maxWidth) {
      line = next;
    } else {
      if (line) lines.push(line);
      // handle very long token
      if (font.widthOfTextAtSize(w, fontSize) > maxWidth) {
        let chunk = "";
        for (const ch of w) {
          const n = chunk + ch;
          if (font.widthOfTextAtSize(n, fontSize) <= maxWidth) chunk = n;
          else {
            if (chunk) lines.push(chunk);
            chunk = ch;
          }
        }
        line = chunk;
      } else {
        line = w;
      }
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

type Cursor = { page: any; y: number };

function newPage(pdf: PDFDocument): Cursor {
  const page = pdf.addPage([PAGE_W, PAGE_H]);
  page.setRotation(degrees(0));
  return { page, y: PAGE_H - MARGIN };
}

function ensureSpace(pdf: PDFDocument, cur: Cursor, needed: number): Cursor {
  if (cur.y - needed < MARGIN) return newPage(pdf);
  return cur;
}

function drawTextBlock(pdf: PDFDocument, cur: Cursor, text: string, font: any, size: number, color: any, spacing = 1.25) {
  const maxW = PAGE_W - MARGIN * 2;
  const lines = wrapLines(text, font, size, maxW);
  const lineH = size * spacing;

  cur = ensureSpace(pdf, cur, lines.length * lineH + 6);
  for (const line of lines) {
    cur.page.drawText(line, { x: MARGIN, y: cur.y, size, font, color });
    cur.y -= lineH;
  }
  cur.y -= 6;
  return cur;
}

function drawHr(pdf: PDFDocument, cur: Cursor) {
  cur = ensureSpace(pdf, cur, 18);
  cur.page.drawLine({
    start: { x: MARGIN, y: cur.y },
    end: { x: PAGE_W - MARGIN, y: cur.y },
    thickness: 1,
    color: rgb(0.86, 0.89, 0.92),
  });
  cur.y -= 14;
  return cur;
}

function drawKeyValueRow(cur: Cursor, fonts: Fonts, key: string, value: string) {
  const keyFontSize = 10;
  const valFontSize = 10;

  const keyW = 160;
  const maxW = PAGE_W - MARGIN * 2;
  const valW = maxW - keyW;

  const keyLines = wrapLines(key, fonts.bold, keyFontSize, keyW);
  const valLines = wrapLines(value, fonts.regular, valFontSize, valW);

  const lines = Math.max(keyLines.length, valLines.length);
  const lineH = 14;
  const needed = lines * lineH + 6;

  return { needed, render: (c: Cursor) => {
    for (let i = 0; i < lines; i++) {
      const ky = keyLines[i] || "";
      const vy = valLines[i] || "";
      c.page.drawText(ky, { x: MARGIN, y: c.y, size: keyFontSize, font: fonts.bold, color: rgb(0.10, 0.12, 0.14) });
      c.page.drawText(vy, { x: MARGIN + keyW + 10, y: c.y, size: valFontSize, font: fonts.regular, color: rgb(0.10, 0.12, 0.14) });
      c.y -= lineH;
    }
    c.y -= 4;
    return c;
  }};
}

function evidenceToHuman(evidence: any): { bullets: string[] } {
  const bullets: string[] = [];

  if (Array.isArray(evidence)) {
    for (const item of evidence) {
      if (item && typeof item === "object") {
        const type = safeStr(String((item as any).type || ""), 40);
        const key = safeStr(String((item as any).key || ""), 80);
        const value = (item as any).value;

        if (type === "metric") {
          bullets.push(`${key || "metric"}: ${String(value)}`);
        } else if (type === "note") {
          bullets.push(String((item as any).value || ""));
        } else {
          // generic object
          const json = safeStr(JSON.stringify(item), 500);
          if (json) bullets.push(json);
        }
      } else if (typeof item === "string") {
        bullets.push(item);
      }
    }
    return { bullets: bullets.filter(Boolean) };
  }

  if (evidence && typeof evidence === "object") {
    // common shape {metrics:{...}} etc
    const entries = Object.entries(evidence);
    for (const [k, v] of entries) bullets.push(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
    return { bullets: bullets.filter(Boolean) };
  }

  if (typeof evidence === "string") return { bullets: [evidence] };

  return { bullets: [] };
}

function findingMeaning(f: any): string {
  const title = safeStr(f?.title, 200).toLowerCase();
  if (title.includes("coverage")) {
    return "This describes how much text was available to audit. More extracted text usually means stronger coverage; missing scans/exhibits can reduce coverage.";
  }
  if (title.includes("gap")) {
    return "This highlights what the audit may have missed (for example scanned pages or exhibits). Consider OCR or adding missing attachments if coverage seems low.";
  }
  return "This is a research finding derived from extracted record text and attached evidence.";
}

/* ---------------------------------- route --------------------------------- */

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const analysisId = safeStr(url.searchParams.get("analysisId") || "", 120);
    if (!analysisId) return NextResponse.json({ ok: false, error: "analysisId is required" }, { status: 400 });

    const auth = await requireSystemOrUser(req);
    if (auth.ok === false) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

    const supabase = createClient(
      mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
      mustEnv("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false } }
    );

    const { data: analysis, error: aErr } = await supabase
      .from("analyses")
      .select("*")
      .eq("id", analysisId)
      .maybeSingle();

    if (aErr) return NextResponse.json({ ok: false, error: aErr.message }, { status: 500 });
    if (!analysis) return NextResponse.json({ ok: false, error: "Analysis not found" }, { status: 404 });

    if (auth.mode === "user" && analysis.owner_id && analysis.owner_id !== auth.userId) {
      return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
    }

    const dbEntitlement = auth.mode === "user" ? await tryGetDbEntitlement(supabase, auth.userId) : null;
    const access = resolveAccess({
      authMode: auth.mode,
      userId: auth.mode === "user" ? auth.userId : null,
      analysisMeta: analysis?.meta || {},
      dbEntitlement,
    });

    // hard gate: only pro can export
    if (!access.exportAllowed) {
      return NextResponse.json(
        { ok: false, error: "PDF export requires Pro tier.", code: "PDF_EXPORT_REQUIRES_PRO" },
        { status: 402 }
      );
    }

    const meta = analysis?.meta || {};
    const findings = Array.isArray(meta?.findings) ? meta.findings : [];
    const executedAt = safeStr(meta?.executed_at || "", 80) || new Date().toISOString();
    const tier = normalizeTier(meta?.executed_tier || meta?.tier);

    // Pull a couple helpful “coverage” numbers if they exist
    let chunkCount: number | null = null;
    let statementEstimate: number | null = null;
    for (const f of findings) {
      if (safeStr(f?.title, 200).toLowerCase().includes("coverage")) {
        const ev = evidenceToHuman(f?.evidence);
        for (const b of ev.bullets) {
          const m1 = b.match(/^chunk_count:\s*(\d+)/i);
          const m2 = b.match(/^statement_estimate:\s*(\d+)/i);
          if (m1) chunkCount = Number(m1[1]);
          if (m2) statementEstimate = Number(m2[1]);
        }
      }
    }

    // ----------------- build pdf -----------------
    const pdf = await PDFDocument.create();
    const fonts: Fonts = {
      regular: await pdf.embedFont(StandardFonts.Helvetica),
      bold: await pdf.embedFont(StandardFonts.HelveticaBold),
      mono: await pdf.embedFont(StandardFonts.Courier),
    };

    let cur = newPage(pdf);

    // Title
    cur = drawTextBlock(pdf, cur, "Legal Record Research Report", fonts.bold, 20, rgb(0.06, 0.09, 0.12));
    cur = drawTextBlock(
      pdf,
      cur,
      "This report summarizes extracted-record findings for research purposes only.",
      fonts.regular,
      11,
      rgb(0.18, 0.22, 0.26)
    );

    // Disclaimer
    cur = drawTextBlock(
      pdf,
      cur,
      "Important: This is not legal advice. It is an automated research summary based on extracted text and available sources.",
      fonts.regular,
      10,
      rgb(0.35, 0.38, 0.42)
    );

    cur = drawHr(pdf, cur);

    // At a glance
    cur = drawTextBlock(pdf, cur, "At a glance", fonts.bold, 13, rgb(0.06, 0.09, 0.12));

    const rows: Array<{ k: string; v: string }> = [
      { k: "Analysis ID", v: String(analysis.id) },
      { k: "Status", v: safeStr(analysis.status, 60) || "—" },
      { k: "Target document", v: safeStr(analysis.target_document_id, 120) || "—" },
      { k: "Executed at", v: fmtDate(executedAt) },
      { k: "Tier", v: tier.toUpperCase() },
      { k: "Coverage", v: chunkCount != null ? `${chunkCount} text chunks` : "—" },
      { k: "Sentence estimate", v: statementEstimate != null ? `${statementEstimate}` : "—" },
      { k: "Findings", v: `${findings.length}` },
    ];

    for (const r of rows) {
      const kv = drawKeyValueRow(cur, fonts, r.k, r.v);
      cur = ensureSpace(pdf, cur, kv.needed);
      cur = kv.render(cur);
    }

    cur = drawHr(pdf, cur);

    // Plain-English summary
    cur = drawTextBlock(pdf, cur, "Summary", fonts.bold, 13, rgb(0.06, 0.09, 0.12));

    const summary =
      safeStr(analysis.summary, 2000) ||
      `This audit processed extracted record text and generated ${findings.length} research finding(s).`;

    cur = drawTextBlock(pdf, cur, summary, fonts.regular, 11, rgb(0.12, 0.14, 0.16));

    cur = drawHr(pdf, cur);

    // Findings
    cur = drawTextBlock(pdf, cur, `Findings (${findings.length})`, fonts.bold, 13, rgb(0.06, 0.09, 0.12));

    if (!findings.length) {
      cur = drawTextBlock(
        pdf,
        cur,
        "No findings are available yet. Run the audit again after materializing the document.",
        fonts.regular,
        11,
        rgb(0.12, 0.14, 0.16)
      );
    } else {
      let idx = 1;
      for (const f of findings) {
        const title = safeStr(f?.title, 240) || `Finding ${idx}`;
        const sev = severityLabel(f?.severity);
        const claim =
          safeStr(f?.claim, 4000) || safeStr(f?.detail, 4000) || "No description provided.";
        const meaning = findingMeaning(f);
        const ev = evidenceToHuman(f?.evidence);

        // Card spacing
        cur = ensureSpace(pdf, cur, 140);

        // Heading line: "1. Title" + severity badge
        const heading = `${idx}. ${title}`;
        cur.page.drawText(heading, {
          x: MARGIN,
          y: cur.y,
          size: 12,
          font: fonts.bold,
          color: rgb(0.06, 0.09, 0.12),
        });

        // severity badge
        const badge = sev.toUpperCase();
        const badgeW = fonts.bold.widthOfTextAtSize(badge, 9) + 10;
        const badgeX = PAGE_W - MARGIN - badgeW;
        cur.page.drawRectangle({
          x: badgeX,
          y: cur.y - 3,
          width: badgeW,
          height: 14,
          borderColor: severityColor(f?.severity),
          borderWidth: 1,
          color: rgb(1, 1, 1),
        });
        cur.page.drawText(badge, {
          x: badgeX + 5,
          y: cur.y,
          size: 9,
          font: fonts.bold,
          color: severityColor(f?.severity),
        });

        cur.y -= 18;

        // What it says
        cur = drawTextBlock(pdf, cur, claim, fonts.regular, 11, rgb(0.12, 0.14, 0.16));

        // What it means
        cur = drawTextBlock(pdf, cur, `What it means: ${meaning}`, fonts.regular, 10.5, rgb(0.20, 0.24, 0.28));

            // Evidence
        if (ev.bullets.length) {
          cur = drawTextBlock(
            pdf,
            cur,
            "Evidence:",
            fonts.bold,
            11,
            rgb(0.06, 0.09, 0.12)
          );

          for (const b of ev.bullets) {
            cur = drawTextBlock(
              pdf,
              cur,
              `• ${b}`,
              fonts.regular,
              10.5,
              rgb(0.12, 0.14, 0.16)
            );
          }
        }

        cur = drawHr(pdf, cur);
        idx++;
      }
    }

    // Footer (page numbers)
    const pages = pdf.getPages();
    const pageCount = pages.length;

    pages.forEach((p, i) => {
      p.drawText(`Page ${i + 1} of ${pageCount}`, {
        x: PAGE_W - MARGIN - 80,
        y: 24,
        size: 9,
        font: fonts.regular,
        color: rgb(0.45, 0.48, 0.52),
      });
    });

    const bytes = await pdf.save();

    return new NextResponse(Buffer.from(bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="case_fact_audit_${analysis.id}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: 500 }
    );
  }
}
