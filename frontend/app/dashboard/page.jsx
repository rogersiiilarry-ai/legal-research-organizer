import Link from "next/link";

export default function Page() {
  return (
    <main
      style={{
        minHeight: "calc(100vh - 3rem)",
        padding: "1.8rem 1.5rem 2.5rem",
        display: "flex",
        flexDirection: "column",
        gap: "1.2rem",
      }}
    >
      <header style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
        <h1 style={{ fontSize: "1.6rem", margin: 0 }}></h1>
        <p style={{ margin: 0, fontSize: "0.95rem", opacity: 0.85 }}>
          
        </p>
        <nav
          style={{
            marginTop: "0.6rem",
            display: "flex",
            flexWrap: "wrap",
            gap: "0.6rem",
            fontSize: "0.85rem",
            opacity: 0.9,
          }}
        >
          <Link href="/dashboard">Dashboard</Link>
          <Link href="/search">Search</Link>
          <Link href="/compare">Compare</Link>
          <Link href="/issues">Issues</Link>
          <Link href="/doctrine-timeline">Doctrine Timeline</Link>
          <Link href="/jobs">Jobs</Link>
          <Link href="/compliance">Compliance</Link>
          <Link href="/pricing">Pricing</Link>
          <Link href="/traces">Traces</Link>
          <Link href="/builder">Builder</Link>
        </nav>
      </header>

      <section
        style={{
          borderRadius: "1rem",
          border: "1px solid rgba(148, 163, 184, 0.35)",
          padding: "1rem",
          background:
            "radial-gradient(circle at top left, rgba(37, 99, 235, 0.18), transparent), #020617",
        }}
      >
        <div style={{ fontSize: "0.9rem", opacity: 0.9, marginBottom: "0.4rem" }}>
          Next steps
        </div>
        <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.85rem", opacity: 0.85 }}>
          <li>Wire this page to Supabase tables and RLS policies.</li>
          <li>Bind UI to ingestion state, queues, and audit logs.</li>
          <li>Keep “citation-locked” responses enforced at the API boundary.</li>
        </ul>
      </section>
    </main>
  );
}
