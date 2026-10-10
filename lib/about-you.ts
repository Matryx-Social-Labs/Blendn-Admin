/**
 * The "about you" vocabulary of matching v2 (plan v2 §8): languages, home
 * state, an opt-in sign, and the IPL teams that live in the interest tree.
 *
 * Server-owned lists, served by `GET /api/mobile/profile-options`, for the
 * reason `lib/work-fields.ts` gives: a free-text field is two people who typed
 * "Malayalam" and "malayalam " never matching, and a client copy is every
 * installed build unable to show the next value.
 *
 * ## Shown, never ranked
 *
 * Every field here is **display only** (§8.1, "rank on what people chose and
 * did; display what they are"). Ranking by language, state or sign would sort
 * rooms by region or by stars. `lib/matching.ts` never reads them into a
 * score; `__tests__/matching-v2.test.ts` proves a room ranks the same when
 * only these differ.
 *
 * ## Tier B
 *
 * Languages, home state and sign are origin-like quasi-identifiers (§8.5):
 * "29, from Kerala, a Leo" in a room of seven is a person. So before a reveal
 * they appear only in rooms of eight or more, and at most one of them per card
 * (`orderLabels` in lib/matching.ts).
 *
 * ## Never built
 *
 * No caste, community, religion, gotra, surname, kundli or guna score, and no
 * veg / non-veg (a documented caste proxy in India). Not as a field, a filter
 * or a rank — `__tests__/never-build-fields.test.ts` fails the build if one
 * appears. A sign is the person's own pick, never derived behind their back
 * and never computed from a birth time or place.
 *
 * No database import: `lib/validations/profile.ts` reads these, and a client
 * component may import that (`__tests__/server-import-boundary.test.ts`).
 */

export interface Option {
  /** Stored. Stable — renaming a label must not orphan rows. */
  slug: string
  /** What the app shows. */
  label: string
}

/**
 * Languages people speak, besides English.
 *
 * English is left out on purpose: nearly everyone in the room shares it, so
 * "you both speak English" is no reason to walk over. "Learning Kannada" is
 * its own entry — a warm bridge between people from Bengaluru and people new
 * to it, and the one language overlap that is about wanting to belong.
 */
export const LANGUAGES: readonly Option[] = [
  { slug: "kannada", label: "Kannada" },
  { slug: "kannada_learning", label: "Learning Kannada" },
  { slug: "tamil", label: "Tamil" },
  { slug: "telugu", label: "Telugu" },
  { slug: "malayalam", label: "Malayalam" },
  { slug: "hindi", label: "Hindi" },
  { slug: "urdu", label: "Urdu" },
  { slug: "marathi", label: "Marathi" },
  { slug: "bengali", label: "Bengali" },
  { slug: "gujarati", label: "Gujarati" },
  { slug: "punjabi", label: "Punjabi" },
  { slug: "odia", label: "Odia" },
  { slug: "konkani", label: "Konkani" },
  { slug: "tulu", label: "Tulu" },
  { slug: "kodava", label: "Kodava" },
  { slug: "assamese", label: "Assamese" },
  { slug: "bhojpuri", label: "Bhojpuri" },
  { slug: "nepali", label: "Nepali" },
] as const

/** Five is a person's languages, not a list to game. */
export const MAX_LANGUAGES = 5

/**
 * State or union territory, never a district or a town: a district and a
 * language together can name somebody. "Grew up abroad" is first-class rather
 * than a missing answer.
 */
export const HOME_STATES: readonly Option[] = [
  { slug: "andhra_pradesh", label: "Andhra Pradesh" },
  { slug: "arunachal_pradesh", label: "Arunachal Pradesh" },
  { slug: "assam", label: "Assam" },
  { slug: "bihar", label: "Bihar" },
  { slug: "chhattisgarh", label: "Chhattisgarh" },
  { slug: "goa", label: "Goa" },
  { slug: "gujarat", label: "Gujarat" },
  { slug: "haryana", label: "Haryana" },
  { slug: "himachal_pradesh", label: "Himachal Pradesh" },
  { slug: "jharkhand", label: "Jharkhand" },
  { slug: "karnataka", label: "Karnataka" },
  { slug: "kerala", label: "Kerala" },
  { slug: "madhya_pradesh", label: "Madhya Pradesh" },
  { slug: "maharashtra", label: "Maharashtra" },
  { slug: "manipur", label: "Manipur" },
  { slug: "meghalaya", label: "Meghalaya" },
  { slug: "mizoram", label: "Mizoram" },
  { slug: "nagaland", label: "Nagaland" },
  { slug: "odisha", label: "Odisha" },
  { slug: "punjab", label: "Punjab" },
  { slug: "rajasthan", label: "Rajasthan" },
  { slug: "sikkim", label: "Sikkim" },
  { slug: "tamil_nadu", label: "Tamil Nadu" },
  { slug: "telangana", label: "Telangana" },
  { slug: "tripura", label: "Tripura" },
  { slug: "uttar_pradesh", label: "Uttar Pradesh" },
  { slug: "uttarakhand", label: "Uttarakhand" },
  { slug: "west_bengal", label: "West Bengal" },
  { slug: "andaman_nicobar", label: "Andaman and Nicobar Islands" },
  { slug: "chandigarh", label: "Chandigarh" },
  { slug: "dadra_nagar_haveli_daman_diu", label: "Dadra and Nagar Haveli and Daman and Diu" },
  { slug: "delhi", label: "Delhi" },
  { slug: "jammu_kashmir", label: "Jammu and Kashmir" },
  { slug: "ladakh", label: "Ladakh" },
  { slug: "lakshadweep", label: "Lakshadweep" },
  { slug: "puducherry", label: "Puducherry" },
  { slug: "abroad", label: "Grew up abroad" },
] as const

export type SignSystem = "western" | "rashi"
export const SIGN_SYSTEMS: readonly SignSystem[] = ["western", "rashi"]

export type Element = "fire" | "earth" | "air" | "water"

export interface Sign {
  /** Stored in `profiles.sun_sign`, the same slug in either system. */
  slug: string
  /** The Western name. */
  western: string
  /** The Vedic rashi with the same place in the zodiac. */
  rashi: string
  symbol: string
  element: Element
}

/**
 * The twelve signs, in zodiac order. A rashi and the Western sign in the same
 * place share a slug: "Leo" and "Simha" are one sign in two calendars, which
 * is the overlap line rather than a mismatch.
 *
 * Which one a person sees as *theirs* is `sign_system`. Most Indians know
 * their rashi as the Moon's sign, which a birth date cannot give — so a rashi
 * is only ever what the person picked, never computed.
 */
export const SIGNS: readonly Sign[] = [
  { slug: "aries", western: "Aries", rashi: "Mesha", symbol: "♈", element: "fire" },
  { slug: "taurus", western: "Taurus", rashi: "Vrishabha", symbol: "♉", element: "earth" },
  { slug: "gemini", western: "Gemini", rashi: "Mithuna", symbol: "♊", element: "air" },
  { slug: "cancer", western: "Cancer", rashi: "Karka", symbol: "♋", element: "water" },
  { slug: "leo", western: "Leo", rashi: "Simha", symbol: "♌", element: "fire" },
  { slug: "virgo", western: "Virgo", rashi: "Kanya", symbol: "♍", element: "earth" },
  { slug: "libra", western: "Libra", rashi: "Tula", symbol: "♎", element: "air" },
  { slug: "scorpio", western: "Scorpio", rashi: "Vrishchika", symbol: "♏", element: "water" },
  { slug: "sagittarius", western: "Sagittarius", rashi: "Dhanu", symbol: "♐", element: "fire" },
  { slug: "capricorn", western: "Capricorn", rashi: "Makara", symbol: "♑", element: "earth" },
  { slug: "aquarius", western: "Aquarius", rashi: "Kumbha", symbol: "♒", element: "air" },
  { slug: "pisces", western: "Pisces", rashi: "Meena", symbol: "♓", element: "water" },
] as const

export const ELEMENT_EMOJI: Record<Element, string> = { fire: "🔥", earth: "🌱", air: "🌬️", water: "🌊" }

const LANGUAGE = new Map(LANGUAGES.map((o) => [o.slug, o.label]))
const STATE = new Map(HOME_STATES.map((o) => [o.slug, o.label]))
const SIGN = new Map(SIGNS.map((s) => [s.slug, s]))

export const isLanguage = (slug: unknown): slug is string => typeof slug === "string" && LANGUAGE.has(slug)
export const isHomeState = (slug: unknown): slug is string => typeof slug === "string" && STATE.has(slug)
export const isSign = (slug: unknown): slug is string => typeof slug === "string" && SIGN.has(slug)

/** Labels for stored slugs, unknown ones dropped — a card never renders a raw slug. */
export const languageLabels = (slugs: readonly string[] | null | undefined): string[] =>
  (slugs ?? []).flatMap((s) => (LANGUAGE.has(s) ? [LANGUAGE.get(s)!] : []))
export const homeStateLabel = (slug: string | null | undefined): string | null => (slug && STATE.get(slug)) || null
export const signOf = (slug: string | null | undefined): Sign | null => (slug && SIGN.get(slug)) || null

/** "Leo ♌" or "Simha ♌" — the sign in the calendar its owner picked. */
export function signLabel(slug: string | null | undefined, system: string | null | undefined): string | null {
  const sign = signOf(slug)
  if (!sign) return null
  return `${system === "rashi" ? sign.rashi : sign.western} ${sign.symbol}`
}

/*
 * The tropical (Western) sun sign for a birth date: the day each sign begins.
 * Month is 1-based. A sign runs from its start day to the day before the next.
 */
const SIGN_STARTS: readonly [month: number, day: number, slug: string][] = [
  [1, 20, "aquarius"],
  [2, 19, "pisces"],
  [3, 21, "aries"],
  [4, 20, "taurus"],
  [5, 21, "gemini"],
  [6, 21, "cancer"],
  [7, 23, "leo"],
  [8, 23, "virgo"],
  [9, 23, "libra"],
  [10, 23, "scorpio"],
  [11, 22, "sagittarius"],
  [12, 22, "capricorn"],
]

/**
 * The Western sign a birth date falls in — a **suggestion** for the person's
 * own editor, labelled "Western", never stored until they pick it. Read in UTC
 * because `date_of_birth` is a `@db.Date` with no time of day.
 *
 * Only ever returned to the person themselves (`profileForSelfResponse`): the
 * date is never returned by any route, and neither is anything derived from it
 * that they have not chosen to show.
 */
export function westernSignFor(dateOfBirth: Date | null | undefined): string | null {
  if (!dateOfBirth || Number.isNaN(dateOfBirth.getTime())) return null
  const m = dateOfBirth.getUTCMonth() + 1
  const d = dateOfBirth.getUTCDate()
  let slug = "capricorn" // 1–19 January
  for (const [month, day, s] of SIGN_STARTS) {
    if (m > month || (m === month && d >= day)) slug = s
  }
  return slug
}

/**
 * The ten IPL teams, as interest leaves under "IPL" (`ipl-<code>` slugs,
 * written by the migration and `scripts/seed-categories.ts`).
 *
 * Leaves of the interest tree, not columns: they inherit IDF rarity, which is
 * the whole point — in Bengaluru "Both RCB" is near universal and weighs
 * little, while two CSK fans in a room of RCB fans have found each other. The
 * heart is each team's colour, for the card line.
 *
 * "Don't follow cricket" is no pick at all, not a leaf: an interest nobody
 * shares with intent would rank people on not caring.
 */
export const IPL_TEAMS: readonly { code: string; name: string; heart: string }[] = [
  { code: "CSK", name: "Chennai Super Kings", heart: "💛" },
  { code: "DC", name: "Delhi Capitals", heart: "💙" },
  { code: "GT", name: "Gujarat Titans", heart: "🩵" },
  { code: "KKR", name: "Kolkata Knight Riders", heart: "💜" },
  { code: "LSG", name: "Lucknow Super Giants", heart: "🩵" },
  { code: "MI", name: "Mumbai Indians", heart: "💙" },
  { code: "PBKS", name: "Punjab Kings", heart: "❤️" },
  { code: "RR", name: "Rajasthan Royals", heart: "💗" },
  { code: "RCB", name: "Royal Challengers Bengaluru", heart: "❤️" },
  { code: "SRH", name: "Sunrisers Hyderabad", heart: "🧡" },
] as const

/** The interest-tree parent the teams sit under. */
export const IPL_PARENT_SLUG = "ipl"

/**
 * Cuisine loves, as interest leaves under the existing "Food & Drink" parent.
 * Tastes, never diets: nothing here says or implies veg or non-veg, which in
 * India is a caste proxy (§8.4). Every one has a version for everybody.
 */
export const CUISINE_LOVES: readonly string[] = [
  "Biryani",
  "Dosa",
  "Chaat",
  "Momos",
  "Street food",
  "Desserts",
  "Indo-Chinese",
  "Pizza",
] as const
