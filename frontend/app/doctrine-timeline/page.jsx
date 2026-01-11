import PageShell from "../../components/PageShell";

export default function DoctrineTimelinePage() {
  return (
    <PageShell
      title="Doctrine timeline"
      subtitle="Visualize how an issue/doctrine evolves across cases over time."
      metaRight={
        <>
          <div>Mode: Timeline</div>
          <div>Source: case graph</div>
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
        Placeholder. Next: timeline fed by edges (cites/overrules/distinguishes) + issue tags.
      </section>
    </PageShell>
  );
}
