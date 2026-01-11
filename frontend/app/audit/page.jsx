import React, { Suspense } from "react";
import AuditClient from "./AuditClient";

export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <Suspense fallback={<div style={{ padding: 24, color: "#f8fafc" }}>Loading…</div>}>
      <AuditClient />
    </Suspense>
  );
}
