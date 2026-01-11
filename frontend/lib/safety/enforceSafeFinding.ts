// frontend/app/lib/safety/enforceSafeFinding.ts
const BANNED =
  /(corrupt|brib|collusion|conspir|cover[- ]?up|falsif|forge|tamper|frame[d]?|misconduct|unlawful)/i;
const INTENT = /(lied|hid|withheld|targeted|planted|fabricated)/i;

export function enforceSafeFinding(claim: string) {
  const s = String(claim || "").trim();
  if (!s) throw new Error("Empty claim");
  if (BANNED.test(s) || INTENT.test(s)) {
    throw new Error("Prohibited allegation or intent language detected");
  }
  return s;
}
