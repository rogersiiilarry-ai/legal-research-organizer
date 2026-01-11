export function michiganAuthority(courtId: string) {
  const id = courtId.toLowerCase();

  if (id === "mich") {
    return { score: 95, binding: true, level: "supreme" };
  }

  if (id === "michctapp") {
    return { score: 85, binding: true, level: "appellate" };
  }

  if (id === "mied" || id === "miwd") {
    return { score: 75, binding: false, level: "federal_district" };
  }

  if (id === "ca6") {
    return { score: 80, binding: false, level: "federal_appellate" };
  }

  return { score: 50, binding: false, level: "unknown" };
}
