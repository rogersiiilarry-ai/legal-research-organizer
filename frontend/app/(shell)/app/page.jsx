// frontend/app/page.jsx
import Link from "next/link";

export default function AppHome() {
  const linkStyle = { textDecoration: "none", fontWeight: 600 };

  return (
    <main
      style={{
        minHeight: "calc(100vh - 3.2rem)",
        padding: "1.6rem 1.4rem",
        display: "flex",
        flexDirection: "column",
        gap: 18,
        maxWidth: 980,
        margin: "0 auto",
      }}
    >
      <div className="card">
        <h1 style={{ margin: 0, fontSize: 22 }}>Workspace</h1>
        <p className="muted" style={{ marginTop: 10, marginBottom: 0, maxWidth: 860 }}>
          <strong>
            A research system that organizes legal records and highlights factual consistency,
            inconsistencies, and source coverage.
          </strong>
        </p>
      </div>

      <div className="card">
        <div style={{ fontWeight: 750, marginBottom: 8 }}>Core Research Tools</div>
        <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 8 }}>
          <li>
            <Link href="/search" style={linkStyle}>
              Search Records
            </Link>
          </li>
          <li>
            <Link href="/upload" style={linkStyle}>
              Upload Records (PDF / URL)
            </Link>
          </li>
          <li>
            <Link href="/audit" style={linkStyle}>
              Fact Audit (Record Consistency)
            </Link>
          </li>
        </ul>
      </div>

      <div className="card">
        <div style={{ fontWeight: 750, marginBottom: 8 }}>Structured Entities</div>
        <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 8 }}>
          <li>
            <Link href="/app/cases" style={linkStyle}>
              Cases
            </Link>
          </li>
          <li>
            <Link href="/app/issues" style={linkStyle}>
              Issues
            </Link>
          </li>
          <li>
            <Link href="/app/citations" style={linkStyle}>
              Citations
            </Link>
          </li>
        </ul>
      </div>

      <div className="card">
        <div style={{ fontWeight: 750, marginBottom: 8 }}>System</div>
        <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 8 }}>
          <li>
            <Link href="/integrations" style={linkStyle}>
              Integrations
            </Link>
          </li>
        </ul>
      </div>
    </main>
  );
}
