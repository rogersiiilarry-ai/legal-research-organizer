export default function PageShell({
  title,
  subtitle,
  metaRight,
  children,
}) {
  return (
    <main
      style={{
        minHeight: "calc(100vh - 3rem)",
        padding: "1.8rem 1.5rem 2.5rem",
        display: "flex",
        flexDirection: "column",
        gap: "1.5rem",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
          <h1 style={{ fontSize: "1.6rem", margin: 0 }}>{title}</h1>
          {subtitle ? (
            <p style={{ margin: 0, fontSize: "0.95rem", opacity: 0.85 }}>{subtitle}</p>
          ) : null}
        </div>

        {metaRight ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.3rem",
              fontSize: "0.8rem",
              alignItems: "flex-end",
              opacity: 0.8,
              whiteSpace: "nowrap",
            }}
          >
            {metaRight}
          </div>
        ) : null}
      </div>

      {children}
    </main>
  );
}
