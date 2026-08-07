/**
 * Collapse two spellings of one room into one key.
 *
 * Only used where an event has no `venue_id` — a real link always wins. This is
 * the fallback for events that predate linking, and for free-text venues that
 * will never be listed at all.
 *
 * Deliberately shallow: case, surrounding whitespace, repeated spaces and a
 * trailing comma. It does **not** strip "The", drop punctuation or fuzzy-match,
 * because "The Loft" and "Loft Bar" are plausibly different rooms and merging
 * two real venues is worse than leaving two spellings apart. Getting that wrong
 * silently combines one owner's numbers with another's.
 */
export function normaliseVenueName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, " ")
    .replace(/,+$/, "")
    .toLowerCase()
}
