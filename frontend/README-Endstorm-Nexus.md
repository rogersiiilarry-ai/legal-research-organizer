# legal-research-organizer · Endstorm AppBuilder (Nexus)

This frontend was scaffolded automatically by **Endstorm AppBuilder · Nexus** from the idea:

> Legal Research Organizer SaaS. Next.js 14 + Supabase. Auth, workspace dashboard, case search, case detail view, side-by-side comparison, issue tagging, doctrine timeline, citation-locked answers (no citation=no output), CourtListener + GovInfo ingestion jobs, Postgres schema for cases/citations/issues/edges/audit_logs, compliance layer (research-only, no legal advice), and full install/run instructions.

Mode: **dashboard / CRM shell**

## Tech

- Next.js 14 (App Router)
- React 18
- Nexus-only console routes: \/traces\, \/jobs\
- Basic SaaS shell + login/signup/pricing/builder pages
- \/api/health\ and \/api/idea\ routes

## Getting started

From this \rontend\ folder:

1. Install dependencies

       npm install
       # or
       pnpm install

2. Run the dev server

       npm run dev
       # or
       pnpm dev

3. Open http://localhost:3000 in your browser.

## Project structure (key files)

- \pp/layout.jsx\ – wraps the app in the Nexus ShellHeader + global styles.
- \pp/page.jsx\ – home shell (mode-aware for dashboard).
- \pp/login/page.jsx\, \pp/signup/page.jsx\ – auth placeholders.
- \pp/pricing/page.jsx\ – pricing shell.
- \pp/builder/page.jsx\ – builder placeholder for integrating AppBuilder flows.
- \pp/traces/page.jsx\, \pp/jobs/page.jsx\ – Nexus console routes.
- \pp/api/health/route.js\ – health endpoint for uptime checks.
- \pp/api/idea/route.js\ – introspection endpoint exposing the idea + mode.

## Wiring it into Endstorm

- Connect \/traces\ and \/jobs\ to your Supabase tables and Orchestrator logs.
- Use the \/api/idea\ route to introspect how this workspace was scaffolded (idea, plan, ui_mode).
- Replace placeholder copy with real product language and flows.

This scaffold is meant as a **starter**. Extend it with:

- Real auth (Supabase Auth, NextAuth, or custom).
- Billing (Stripe, Lemon Squeezy, etc.).
- Data storage (Supabase, Postgres, or your existing stack).
- Deployment targets (Vercel, Render, etc.).