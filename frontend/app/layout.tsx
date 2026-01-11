// frontend/app/app/layout.tsx
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return children;
}
