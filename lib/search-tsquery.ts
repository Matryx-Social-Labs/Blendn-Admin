/**
 * A to_tsquery string from what somebody typed: every word a prefix match, ANDed.
 *
 * Only letters, marks (Indic vowel signs are marks) and digits get through.
 * Removing a list of operators missed `<` and the next one nobody listed, and a
 * stray operator is a thrown syntax error, i.e. a 500 (SCRUM-946).
 */
export function tsQueryFrom(q: string): string | null {
  const words = q.replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean)
  return words.length ? words.map((w) => `${w}:*`).join(" & ") : null
}
