"use client";

// frontend/app/upload/page.jsx
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

function safeStr(v) {
  return typeof v === "string" ? v.trim() : "";
}

function isHttpUrl(v) {
  return /^https?:\/\//i.test(safeStr(v));
}

function normalizeUiError(message) {
  const m = safeStr(message);
  if (!m) return "Something went wrong.";

  if (/bucket not found/i.test(m)) {
    return "Storage bucket not found. Create a Storage bucket named 'documents' (or update the API to use your bucket name).";
  }

  if (/returned html/i.test(m) || /not a pdf/i.test(m) || /<!doctype html/i.test(m)) {
    return "That link returned HTML (not a direct PDF). Download the PDF and upload it as a file instead.";
  }

  return m;
}

async function fetchJson(url, init) {
  const res = await fetch(url, {
    cache: "no-store",
    credentials: "include",
    ...(init || {}),
  });

  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(j?.error || j?.message || `Request failed (${res.status})`);
  }
  return j;
}

export default function UploadPage() {
  const router = useRouter();

  const [mode, setMode] = useState("file"); // "file" | "url"
  const [title, setTitle] = useState("");
  const [jurisdiction, setJurisdiction] = useState("MI");

  const [file, setFile] = useState(null);
  const [pdfUrl, setPdfUrl] = useState("");

  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [docId, setDocId] = useState("");
  const [loading, setLoading] = useState(false);

  const canSubmit = useMemo(() => {
    if (loading) return false;
    if (mode === "file") return !!file;
    return isHttpUrl(pdfUrl);
  }, [mode, file, pdfUrl, loading]);

  async function uploadPdfToStorage(selectedFile) {
    const fd = new FormData();
    fd.append("file", selectedFile);
    fd.append("folder", "uploads");

    const res = await fetch("/api/upload/pdf", {
      method: "POST",
      body: fd,
      credentials: "include",
      cache: "no-store",
    });

    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j?.error || j?.message || `Upload failed (${res.status})`);

    // accept any common field name
    const url = safeStr(j?.url) || safeStr(j?.signedUrl) || safeStr(j?.publicUrl) || safeStr(j?.uploadUrl);
    if (!url || !isHttpUrl(url)) {
      throw new Error("Upload succeeded but no URL was returned by /api/upload/pdf.");
    }

    return {
      bucket: safeStr(j?.bucket),
      path: safeStr(j?.path),
      url,
      signedUrl: safeStr(j?.signedUrl),
      publicUrl: safeStr(j?.publicUrl),
    };
  }

  async function createDocumentFromPdfUrl(url, extraRaw) {
    const payload = {
      title: safeStr(title) || null,
      pdf_url: url,
      jurisdiction: safeStr(jurisdiction) || "MI",
      source: mode === "file" ? "storage_upload" : "pdf_url",
      raw: {
        uploaded_via: "ui",
        uploaded_at: new Date().toISOString(),
        ...(extraRaw || {}),
      },
    };

    const j = await fetchJson("/api/documents/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const createdId = safeStr(j?.documentId || j?.id);
    if (!createdId) throw new Error("Create document succeeded but no documentId was returned.");
    return { documentId: createdId, response: j };
  }

  async function onSubmit(e) {
    e.preventDefault();
    setErr("");
    setInfo("");
    setDocId("");

    if (!canSubmit) return;

    setLoading(true);
    try {
      if (mode === "file") {
        setInfo("Uploading PDF...");
        const up = await uploadPdfToStorage(file);

        setInfo("PDF uploaded. Creating document record...");
        const created = await createDocumentFromPdfUrl(up.url, {
          uploaded: true,
          storage_bucket: up.bucket || "documents",
          storage_path: up.path,
          storage_signed_url: up.signedUrl || null,
          storage_public_url: up.publicUrl || null,
        });

        setDocId(created.documentId);
        setInfo("Done. Document created successfully.");
      } else {
        const finalPdfUrl = safeStr(pdfUrl);
        if (!isHttpUrl(finalPdfUrl)) throw new Error("Please paste a valid http(s) PDF URL.");

        setInfo("Creating document record from URL...");
        const created = await createDocumentFromPdfUrl(finalPdfUrl, { uploaded: false });

        setDocId(created.documentId);
        setInfo("Done. Document created successfully.");
      }
    } catch (e2) {
      setErr(normalizeUiError(e2?.message || String(e2)));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ padding: "1.6rem 1.4rem", maxWidth: 980, margin: "0 auto" }}>
      <h1 style={{ marginTop: 0, color: "#f8fafc" }}>Upload</h1>
      <p style={{ opacity: 0.85, color: "rgba(248,250,252,.78)" }}>
        Recommended: upload a downloaded PDF file. This avoids HTML/viewer links that break materialize.
      </p>

      <div className="card" style={{ marginTop: 12 }}>
        <div style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
          <label style={{ display: "inline-flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
            <input type="radio" name="mode" value="file" checked={mode === "file"} onChange={() => setMode("file")} />
            <span style={{ color: "#f8fafc" }}>Upload PDF file</span>
          </label>

          <label style={{ display: "inline-flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
            <input type="radio" name="mode" value="url" checked={mode === "url"} onChange={() => setMode("url")} />
            <span style={{ color: "#f8fafc" }}>Paste PDF URL</span>
          </label>
        </div>

        <form onSubmit={onSubmit} style={{ display: "grid", gap: 12 }}>
          <label>
            <div style={{ fontSize: 12, marginBottom: 6, color: "rgba(248,250,252,.78)" }}>Title (optional)</div>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g., People of Michigan v. ..."
              style={{ width: "100%", padding: 10, borderRadius: 10 }}
            />
          </label>

          {mode === "file" ? (
            <label>
              <div style={{ fontSize: 12, marginBottom: 6, color: "rgba(248,250,252,.78)" }}>PDF file (required)</div>
              <input type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} />
              {file ? (
                <div style={{ marginTop: 6, fontSize: 12, color: "rgba(248,250,252,.78)" }}>
                  Selected: {file.name} ({Math.round(file.size / 1024)} KB)
                </div>
              ) : null}
            </label>
          ) : (
            <label>
              <div style={{ fontSize: 12, marginBottom: 6, color: "rgba(248,250,252,.78)" }}>PDF URL (required)</div>
              <input
                value={pdfUrl}
                onChange={(e) => setPdfUrl(e.target.value)}
                placeholder="https://.../file.pdf"
                style={{ width: "100%", padding: 10, borderRadius: 10 }}
                required
              />
              {pdfUrl && !/\.pdf(\?|#|$)/i.test(pdfUrl) ? (
                <div style={{ marginTop: 8, fontSize: 12, color: "rgba(248,250,252,.72)" }}>
                  Tip: viewer links often fail. Prefer a direct “.pdf” download URL, or switch to file upload.
                </div>
              ) : null}
            </label>
          )}

          <label>
            <div style={{ fontSize: 12, marginBottom: 6, color: "rgba(248,250,252,.78)" }}>Jurisdiction</div>
            <input
              value={jurisdiction}
              onChange={(e) => setJurisdiction(e.target.value)}
              placeholder="MI"
              style={{ width: "100%", padding: 10, borderRadius: 10 }}
            />
          </label>

          {err ? <div style={{ color: "#fca5a5", fontSize: 13 }}>{err}</div> : null}
          {info ? <div style={{ color: "rgba(248,250,252,.85)", fontSize: 13 }}>{info}</div> : null}

          <button className="btn btn-primary" disabled={!canSubmit} type="submit" style={{ opacity: canSubmit ? 1 : 0.6 }}>
            {loading ? "Working..." : mode === "file" ? "Upload + Create Document" : "Create Document"}
          </button>
        </form>
      </div>

      {docId ? (
        <div className="card" style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 650, color: "#f8fafc" }}>Created</div>
          <div style={{ marginTop: 6, fontSize: 12, color: "rgba(248,250,252,.72)" }}>document_id</div>
          <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", color: "#f8fafc" }}>{docId}</div>

          <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
            <button className="btn" onClick={() => router.push(`/audit?documentId=${encodeURIComponent(docId)}`)}>
              Go to Audit
            </button>
            <button className="btn btn-ghost" onClick={() => router.push(`/documents`)}>
              Back to Documents
            </button>
          </div>
        </div>
      ) : null}
    </main>
  );
}
