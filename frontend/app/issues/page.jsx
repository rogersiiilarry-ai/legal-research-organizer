import PageShell from '../../components/PageShell';

export default function IssuesPage() {
  return (
    <PageShell
      title="Issues"
      subtitle="Define issue tags and attach them to cases, citations, and comparisons."
      metaRight={
        <>
          <div>Mode: Tags</div>
          <div>Workspace scoped</div>
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
        Placeholder. Next: list/create issue tags (Supabase table), assign to cases, filter search by issue.
      </section>
    </PageShell>
  );
}

