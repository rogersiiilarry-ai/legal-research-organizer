// frontend/app/api/ingest/upload/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

/* ---------------- helpers ---------------- */

function json(status: number, payload: any) {
  return NextResponse.json(payload, { status });
}

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function clampStr(v: any, max = 2000) {
  if (typeof v !== "string") return "";
  const s = v.trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max) : s;
}

function isObject(v: any): v is Record<string, any> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

async function readJson(req: Request): Promise<any> {
  try {
    const buf = await req.arrayBuffer();
    const raw = Buffer.from(buf).toString("utf8").trim();
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  } catch {
    return {};
  }
}

/* ---------------- auth (system OR user) ---------------- */

type AuthOk = { ok: true; mode: "system" | "user"; userId: string | null };
type AuthFail = { ok: false; status: number; error: string };

async function requireSystemOrUser(req: Request): Promise<AuthOk | AuthFail> {
  const expected = process.env.INGEST_SECRET || "";
  const provided = req.headers.get("x-ingest-secret") || "";

  // System mode
  if (expected && provided && provided === expected) {
    return { ok: true, mode: "system", userId: null };
  }

  // User mode
  const cookieStore = cookies();
  const supabaseUrl = mustEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = mustEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

  const supabaseAuth = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      get(name: string) {
        return cookieStore.get(name)?.value;
      },
      set() {},
      remove() {},
    },
  });

  const { data, error } = await supabaseAuth.auth.getUser();
  if (error || !data?.user?.id) return { ok: false, status: 401, error: "Unauthorized" };
  return { ok: true, mode: "user", userId: data.user.id };
}

/* ---------------- handler ---------------- */

export async function POST(req: Request) {
  try {
    const auth = await requireSystemOrUser(req);
    if (!auth.ok) return json(auth.status, { ok: false, phase: "auth", error: auth.error });

    const body = await readJson(req);

    // Accept multiple shapes
    const title = clampStr(body?.title, 240);
    const pdfUrl = clampStr(body?.pdf_url ?? body?.pdfUrl ?? body?.url ?? "", 2000);
    const storagePath = clampStr(body?.storage_path ?? body?.storagePath ?? "", 500);

    const metaIn = isObject(body?.meta) ? body.meta : {};
    const jurisdiction = clampStr(body?.jurisdiction ?? "", 80);
    const source = clampStr(body?.source ?? "upload", 80);

    if (!pdfUrl && !storagePath) {
      return json(400, {
        ok: false,
        phase: "input",
        error: "Provide pdf_url (or url) OR storage_path",
        receivedKeys: Object.keys(body || {}),
      });
    }

    // Service client (DB writes, chunking, etc.)
    const supabaseUrl = mustEnv("NEXT_PUBLIC_SUPABASE_URL");
    const serviceKey = mustEnv("SUPABASE_SERVICE_ROLE_KEY");
    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
      global: { headers: { "x-application-name": "legal-research-organizer" } },
    });

    // Minimal insert into documents table if it exists in your schema.
    // If your table/columns differ, adjust here (but keep the typing fixes).
    const insertRow: Record<string, any> = {
      title: title || "Uploaded Record",
      source,
      jurisdiction: jurisdiction || null,
      pdf_url: pdfUrl || null,
      storage_path: storagePath || null,
      meta: {
        ...metaIn,
        ingested_via: "upload",
        mode: auth.mode,
        user_id: auth.userId,
        at: new Date().toISOString(),
      },
    };

    // If you have owner/workspace columns, set them without breaking if absent.
    if (auth.mode === "user" && auth.userId) {
      insertRow.owner_id = auth.userId;
    }

    // Attempt insert; if your DB isn’t migrated yet, return a clean error.
    const { data: doc, error: insErr } = await admin
      .from("documents")
      .insert(insertRow)
      .select("*")
      .maybeSingle();

    if (insErr) {
      return json(500, {
        ok: false,
        phase: "insert_document",
        error: insErr.message,
        details: (insErr as any).details ?? null,
        hint: "Confirm your migrations created the documents table and expected columns.",
      });
    }

    // Optional: if you already have an RPC/materialize step, you can call it here.
    // Keeping build-safe: do not assume it exists.
    // Example:
    // await admin.rpc("rpc_chunk_document", { p_document_id: doc.id });

    return json(200, {
      ok: true,
      phase: "ingested",
      document_id: doc?.id ?? null,
      document: doc ?? null,
      input: {
        pdf_url: pdfUrl || null,
        storage_path: storagePath || null,
      },
    });
  } catch (e: any) {
    return json(500, { ok: false, phase: "exception", error: e?.message || String(e) });
  }
}
