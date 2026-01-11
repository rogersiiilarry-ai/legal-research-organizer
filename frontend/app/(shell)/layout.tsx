import ShellHeader from "../../components/ShellHeader";

export default function ShellLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <ShellHeader />
      {children}
    </>
  );
}
