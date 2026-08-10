/**
 * What someone does, coarsely.
 *
 * The card can already say "you both picked Techno". It cannot say "works in
 * fintech", because the only thing the profile holds is `occupation` — free
 * text like "Senior Backend Engineer at Razorpay", which is an *identity*, not
 * an attribute. It sits behind the identity gate for good reason and always
 * will.
 *
 * This is the version that survives being shown to a stranger in a pseudonymous
 * room: eighteen buckets, no employer, no seniority, no free text. "Someone in
 * this room also works in design" is a reason to say hello; "Priya Raman,
 * Principal Designer at Swiggy" is a way to find her on LinkedIn.
 *
 * ## Why a server-owned list rather than a column of strings
 *
 * The interests taxonomy was built as free text first and cost two PRs to
 * migrate — `profiles.interests` is still there, still written by the app, and
 * `lib/interest-coverage.ts` exists to warn that nobody uses it. A free-text
 * work field would repeat that exactly: two people who typed "Software" and
 * "software engineering" would never match, and the fix would be another
 * migration. `GET /api/mobile/work-fields` serves this list so the client
 * cannot invent a nineteenth value.
 *
 * ## Why eighteen
 *
 * Few enough to scroll in one screen, coarse enough that a bucket in a room of
 * fifty holds more than one person. Finer categories are more informative and
 * more identifying, which is the wrong trade for a room where the whole point
 * is that nobody has to be findable.
 */

export interface WorkField {
  /** Stored on the profile. Stable — renaming a label must not orphan rows. */
  slug: string
  /** What the app shows. */
  label: string
}

export const WORK_FIELDS: readonly WorkField[] = [
  { slug: "software", label: "Software & IT" },
  { slug: "design", label: "Design" },
  { slug: "product", label: "Product" },
  { slug: "data_ai", label: "Data & AI" },
  { slug: "finance", label: "Finance & Banking" },
  { slug: "marketing", label: "Marketing & Advertising" },
  { slug: "sales", label: "Sales & Business Development" },
  { slug: "operations", label: "Operations & Logistics" },
  { slug: "healthcare", label: "Healthcare & Medicine" },
  { slug: "education", label: "Education & Research" },
  { slug: "law_policy", label: "Law & Policy" },
  { slug: "media", label: "Media & Journalism" },
  { slug: "arts", label: "Arts & Entertainment" },
  { slug: "hospitality", label: "Hospitality & Food" },
  { slug: "engineering", label: "Engineering & Manufacturing" },
  { slug: "consulting", label: "Consulting" },
  { slug: "government_ngo", label: "Government & Non-profit" },
  { slug: "student", label: "Student" },
  // Deliberately last and deliberately present: without it, someone whose work
  // is not on the list either picks a bucket that is wrong or leaves the field
  // blank, and a wrong bucket is worse than an honest "other" for both matching
  // and for the person reading the card.
  { slug: "other", label: "Something else" },
] as const

const BY_SLUG = new Map(WORK_FIELDS.map((f) => [f.slug, f]))

export function isWorkField(slug: unknown): slug is string {
  return typeof slug === "string" && BY_SLUG.has(slug)
}

/** The label for a stored slug, or null — a card never renders a raw slug. */
export function workFieldLabel(slug: string | null | undefined): string | null {
  if (!slug) return null
  return BY_SLUG.get(slug)?.label ?? null
}

/**
 * Below this many people in the room, the field of work is not shown.
 *
 * The roster already returns an age and a city for an unrevealed person. Adding
 * field of work makes it four attributes, and "29, Bengaluru, works in fintech,
 * into techno and board games" is one specific person in a room of eight — the
 * pseudonym stops doing anything at all.
 *
 * Same number and same reasoning as `MIN_ATTENDEES` in
 * `lib/connection-metrics.ts`, which suppresses organiser metrics below this
 * floor because aggregates and anonymity both stop working at small n.
 *
 * Declared here rather than imported: that module imports `db`, and this one is
 * reached from `lib/validations/profile.ts`, which a client component may
 * import — `__tests__/server-import-boundary.test.ts` exists because that has
 * gone wrong before. `__tests__/work-fields.test.ts` asserts the two numbers
 * are equal, so they cannot drift apart in silence.
 */
export const MIN_ROOM_FOR_WORK_FIELD = 8
