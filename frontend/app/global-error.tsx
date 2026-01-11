'use client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
        <h1>App crashed</h1>
        <p><b>Message:</b> {error?.message || "(no message)"}</p>
        {error?.digest ? <p><b>Digest:</b> {error.digest}</p> : null}
        <pre style={{ whiteSpace: "pre-wrap" }}>{error?.stack}</pre>
        <button onClick={() => reset()} style={{ padding: "10px 14px" }}>
          Retry
        </button>
      </body>
    </html>
  );
}
