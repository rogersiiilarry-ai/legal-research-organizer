import PageShell from '../../components/PageShell';

export default function Page() {
  return (
    <PageShell
      title="TITLE_HERE"
      subtitle="SUBTITLE_HERE"
      metaRight={
        <>
          <div>Mode: MODE_HERE</div>
          <div>Rule: citation-locked</div>
        </>
      }
    >
      <section
        style={{
          borderRadius: "1rem",
          border: "1px solid rgba(148, 163, 184, 0.4)",
          padding: "1rem",
          fontSize: "0.9rem",
          opacity: 0.9,
        }}
      >
        Placeholder. Next: wire to Supabase tables + ingestion jobs.
      </section>
    </PageShell>
  );
}

