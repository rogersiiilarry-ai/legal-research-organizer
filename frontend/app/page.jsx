import Link from "next/link";

export default function Home() {
  return (
    <main
      style={{
        minHeight: "calc(100vh - 3.2rem)",
        padding: "2.2rem 1.4rem",
        display: "flex",
        flexDirection: "column",
        gap: "1rem",
        alignItems: "center",
      }}
    >
      <div className="card" style={{ maxWidth: 920, width: "100%" }}>
        <h1 style={{ margin: 0, fontSize: 28, lineHeight: 1.15 }}>
          Organize and Analyze Legal Cases Efficiently
        </h1>

        <p
          className="muted"
          style={{ marginTop: 10, marginBottom: 0, fontSize: 15 }}
        >
          A SaaS platform for legal professionals to search, tag, and compare
          cases with citation-locked answers and integrated ingestion from
          CourtListener and GovInfo. Manage research with compliance and audit
          logs.
        </p>

        <div
          style={{
            display: "flex",
            gap: 10,
            marginTop: 16,
            flexWrap: "wrap",
          }}
        >
          <Link className="btn btn-primary" href="/signup">
            Create account
          </Link>
          <Link className="btn btn-ghost" href="/login">
            Log in
          </Link>
          <Link className="btn btn-ghost" href="/app">
            Open app
          </Link>
        </div>
      </div>

      <div
        className="card"
        style={{ maxWidth: 920, width: "100%", marginTop: 6 }}
      >
        <div style={{ fontWeight: 650, marginBottom: 6 }}>What you get</div>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li>Supabase Auth (signup/login/logout) + protected pages</li>
          <li>Database schema migration for your entities</li>
          <li>CRUD UI + CRUD API routes (ready to extend)</li>
          <li>Integration plug surfaces for your own APIs</li>
        </ul>
      </div>
    </main>
  );
}
