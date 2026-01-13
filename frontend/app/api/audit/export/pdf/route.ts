// frontend/app/api/audit/export/pdf/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { PDFDocument, StandardFonts, rgb, degrees } from "pdf-lib";
import { addTeachingToFindings } from "@/lib/education/teaching";
import { attachSnippetTeaching } from "@/lib/education/attachSnippetTeaching";
import { attachExcerptTeaching } from "@/lib/education/attachExcerptTeaching";
import { attachEvidenceStatus } from "@/lib/education/attachEvidenceStatus";
import { attachDocumentTeaching } from "@/lib/education/attachDocumentTeaching";
import { attachReaderTasks } from "@/lib/education/attachReaderTasks";
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

  const stripBullets = (s: string): string => {
    return String(s ?? "")
      .replace(/^[\s\u2022\-\u2013\u2014]+/g, "") // leading bullets/dashes
      .replace(/â€¢/g, "").replace(/•/g, "")                       // bad-encoded bullet sequence
      .trim();
  };


    const push = (line: string) => {
    const cleaned = stripBullets(safeStr(line, 600));
    if (!cleaned) return;
    bullets.push(cleaned);
  };

  const handleItem = (item: any) => {
    if (!item) return;

    // We only want document-anchored evidence in the PDF:
    // snippet + optional explanation. No object dumps.
    if (typeof item === "string") {
      // Only keep string items if they look like excerpt lines (avoid dumping raw "key: value")
      // You can tighten this later, but this prevents the 'key/type/value' noise.
      const s = safeStr(item, 520);
      if (s && !s.match(/^\s*(key|type|value|count)\s*:/i)) push(s);
      return;
    }

    if (typeof item !== "object") return;

    const sn = typeof item.snippet === "string" ? safeStr(item.snippet, 520) : "";
    const ex = typeof item.explanation === "string" ? safeStr(item.explanation, 420) : "";

    // Only print if we have an excerpt/snippet from the uploaded document
    if (sn) {
      push(sn);
      if (ex) push(`Why it matters: ${ex}`);
    }
  };

  if (Array.isArray(evidence)) {
    for (const item of evidence) handleItem(item);
    return { bullets };
  }

  if (typeof evidence === "string") {
    handleItem(evidence);
    return { bullets };
  }

  if (evidence && typeof evidence === "object") {
    // If a single object was provided, still enforce snippet-only output
    handleItem(evidence);
    return { bullets };
  }

  return { bullets };
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
    const analysisId = url.searchParams.get("analysisId") || url.searchParams.get("id") || "";
    if (!analysisId) {
      return NextResponse.json({ ok: false, error: "Missing analysisId" }, { status: 400 });
    }

    // The rest of your existing logic should already have built `pdfBytes` (Uint8Array)
    // and/or a `pdfBase64`. If your file currently builds `pdfBytes`, keep that code ABOVE
    // this return and ensure `pdfBytes` is in scope here.

    // ---- IMPORTANT ----
    // If your implementation uses `pdfBytes` (Uint8Array), return as binary:
    // return new NextResponse(pdfBytes, { ...headers... })
    //
    // If it uses `bytes` or `out`, just rename below accordingly.
    // -------------------

    // @ts-ignore - ensure your code defines pdfBytes in the try block
    const body: any = pdfBytes;

    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="audit_${analysisId}.pdf"`,
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
