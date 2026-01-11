import React, { Suspense } from "react";
import LoginClient from "./LoginClient";

export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <Suspense fallback={<main style={{ padding: "2rem 1.4rem" }}>Loading…</main>}>
      <LoginClient />
    </Suspense>
  );
}
