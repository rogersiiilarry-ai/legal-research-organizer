import PageShell from '../../components/PageShell';

export default function JobsPage() {
  return (
    <PageShell
      title="Ingestion jobs"
      subtitle="CourtListener + GovInfo ingestion, normalization, and audit logging."
      metaRight={
        <>
          <div>Mode: Jobs</div>
          <div>Status: wired next</div>
        </>
      }
    >
      <section
        style={{
          borderRadius: "1rem",
          border: "1px dashed rgba(148, 163, 184, 0.4)",
          padding: "1rem",
          fontSize: "0.9rem",
          opacity: 0.85,
        }}
      >
        Placeholder. Next: jobs table + /api/jobs endpoints + queue runner.
      </section>
    </PageShell>
  );
}

