/**
 * The normalised form of a brand name, used to catch duplicates.
 *
 * ## What this is for, and what it is emphatically not for
 *
 * An organiser types a sponsor free-hand, exactly as they type a venue that is
 * not on the platform. Ten organisers typing "Red Bull", "RedBull" and
 * "Red-Bull" produce ten rows, and when the real company arrives to claim, the
 * reviewer has ten to reconcile and the picker shows ten identical entries.
 *
 * So this is a **search key**: it drives the picker's "did you mean" and the
 * per-org uniqueness index.
 *
 * It is **never an identity**. "AT&T" and "ATT" collapse to the same key, and so
 * would an unrelated three-letter brand. Nothing may auto-merge on it, and the
 * merge UI shows full names, websites and claim status precisely so a human is
 * not deciding from this string.
 *
 * Unicode is folded via NFKD so "Café" and "Cafe" match — an organiser typing
 * on a phone keyboard will produce both.
 */
export function normaliseSponsorName(name: string): string {
  return name
    .normalize("NFKD")
    // Strip combining marks left behind by the decomposition (é → e + ´).
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    // Everything that is not a letter or digit, in any script. `&`, spaces,
    // hyphens and punctuation all disappear, which is the whole point.
    .replace(/[^\p{L}\p{N}]+/gu, "")
}

/**
 * Whether two names are the same brand as far as the duplicate check is
 * concerned. A convenience so call sites do not re-derive the rule.
 */
export function isSameSponsorName(a: string, b: string): boolean {
  const ka = normaliseSponsorName(a)
  // Two names that both normalise to nothing ("!!!" and "???") are not "the
  // same brand" — they are both unusable, and saying they match would let one
  // block the other from being created.
  return ka.length > 0 && ka === normaliseSponsorName(b)
}
