/**
 * The slug of a venue's area name: lower case, accents folded, every run of
 * anything else one hyphen. "Koramangala 1st Block" is `koramangala-1st-block`.
 * Null for a name with nothing to slug, so an area is never stored as `""`.
 * The one spelling: the backfill writes it, the `area=` filter and the summary read it.
 */
export function areaSlug(name: string): string | null {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug === "" ? null : slug
}
