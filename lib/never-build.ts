/**
 * Never build (plan v2 §8.4; the owner's ruling of 2026-10-01): caste,
 * community, religion, gotra, surname, kundli / guna, skin tone, veg / non-veg
 * and the diets that stand in for them (vegan, jain, halal), income, height,
 * college and neighbourhood. In India each is a documented caste, community or
 * class proxy, or an exclusion filter with nothing to connect over.
 *
 * One list, read by the build-time guard (`__tests__/never-build-fields.test.ts`)
 * and at runtime wherever an admin can name something a person picks — a
 * category is an interest people hold and a filter events carry, so creating
 * or renaming one is where a proxy would arrive without a deploy
 * (`lib/category-actions.ts`).
 *
 * No database import: a client component may reach this through the actions.
 */

/** Words that are never a field, a filter, an interest or a category. */
export const NEVER_BUILD: ReadonlySet<string> = new Set([
  "kundli",
  "kundali",
  "guna",
  "manglik",
  "nakshatra",
  "varna",
  "caste",
  "jati",
  "gotra",
  "religion",
  "religious",
  "surname",
  "skin",
  "veg",
  "vegetarian",
  "nonveg",
  "eggetarian",
  "vegan",
  "jain",
  "halal",
  "kosher",
  "brahmin",
  "diet",
  "dietary",
  "income",
  "height",
  "college",
  "neighbourhood",
  "neighborhood",
])

/** Whole tokens: split on spaces, punctuation and camel case, lower-cased. */
export function tokens(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/**
 * The never-build words a label or identifier carries — whole tokens, and two
 * adjacent tokens run together, so "Non veg", "non-veg" and "Pure Veg" are all
 * caught, and "Vegetables" or "Community hall" are not mistaken for one.
 */
export function neverBuildHits(text: string, banned: ReadonlySet<string> = NEVER_BUILD): string[] {
  const t = tokens(text)
  const joined = t.slice(1).map((w, i) => t[i] + w)
  return [...new Set([...t, ...joined].filter((w) => banned.has(w)))]
}
