import PageShell from '../../components/PageShell';

export default function PricingPage() {
  return (
    <PageShell
      title="Pricing"
      subtitle="Nexus plan shell. Add Stripe when you’re ready."
      metaRight={
        <>
          <div>Plan: Nexus</div>
          <div>Billing: TBD</div>
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
        Placeholder. Next: plan cards + feature gating based on workspace role and subscription.
      </section>
    </PageShell>
  );
}

