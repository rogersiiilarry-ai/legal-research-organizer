"use client";

import * as React from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          background: "linear-gradient(180deg, #0b1220 0%, #0f172a 100%)",
          color: "#e5e7eb",
          fontFamily: "ui-sans-serif, system-ui, -apple-system",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            maxWidth: 720,
            width: "100%",
            padding: 32,
            borderRadius: 12,
            backgroundColor: "rgba(15, 23, 42, 0.85)",
            boxShadow: "0 20px 40px rgba(0,0,0,0.6)",
            border: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          <h1 style={{ fontSize: 22, marginBottom: 12 }}>
            Something went wrong
          </h1>

          <p style={{ opacity: 0.8, marginBottom: 20 }}>
            The application encountered an unexpected error.
          </p>

          <button
            onClick={() => reset()}
            style={{
              padding: "10px 14px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.2)",
              backgroundColor: "#020617",
              color: "#e5e7eb",
              cursor: "pointer",
              marginBottom: 20,
            }}
          >
            Try again
          </button>

          <div style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Message</div>
            <pre
              style={{
                whiteSpace: "pre-wrap",
                backgroundColor: "#020617",
                padding: 12,
                borderRadius: 6,
                fontSize: 13,
                overflowX: "auto",
              }}
            >
              {error?.message}
            </pre>
          </div>

          {error?.digest && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Digest</div>
              <pre
                style={{
                  whiteSpace: "pre-wrap",
                  backgroundColor: "#020617",
                  padding: 12,
                  borderRadius: 6,
                  fontSize: 12,
                  opacity: 0.8,
                }}
              >
                {error.digest}
              </pre>
            </div>
          )}
        </div>
      </body>
    </html>
  );
}
