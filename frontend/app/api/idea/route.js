export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return new Response(
    JSON.stringify({
      idea: "Legal Research Organizer SaaS. Next.js 14 + Supabase. Auth, workspace dashboard, case search, case detail view, side-by-side comparison, issue tagging, doctrine timeline, citation-locked answers (no citation=no output), CourtListener + GovInfo ingestion jobs, Postgres schema for cases/citations/issues/edges/audit_logs, compliance layer (research-only, no legal advice), and full install/run instructions.",
      mode: "dashboard",
      plan: "Nexus",
    }),
    { headers: { "Content-Type": "application/json" } }
  );
}
