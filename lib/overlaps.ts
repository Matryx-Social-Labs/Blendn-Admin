import {
  ELEMENT_EMOJI,
  homeStateLabel,
  IPL_TEAMS,
  LANGUAGES,
  signOf,
  type SignSystem,
} from "./about-you"
import { collapseToMostSpecific, interestWeight, orderLabels, type Label } from "./matching"
import { answerKey, picked } from "./this-or-that"

/**
 * What a card says beyond the ranking: the named overlaps that are display
 * only, the earned badges, and what a crew holds (plan v2 §8.3–8.7).
 *
 * Pure, like `lib/matching.ts` beside it: no database, no clock. The queries
 * live in `lib/matches.ts` and `lib/crews/presence.ts`.
 *
 * ## Nothing here moves a ranking
 *
 * A language, a home state, a sign, a this-or-that answer: each is printed
 * when two people share it, and none of them is ever added to a score
 * (§8.1). Ranking by origin would sort a room by region; ranking by sign would
 * sort it by stars, which Tinder's own data says predicts nothing. The IPL
 * team is the exception only because it is an *interest* — a leaf in the tree
 * people chose — and so ranks through IDF like every other interest
 * (`rankMatches`), never through anything here.
 *
 * ## Positive only
 *
 * Every line names something both sides hold. There is no mismatch line, no
 * "incompatible", no "doesn't speak Kannada".
 *
 * ## Copy lives here
 *
 * The sentences are composed on the server, unlike the older card fields the
 * app phrases itself, because the best one needs the room: "Both CSK — in RCB
 * country" is only true when RCB is what the room holds, and only the server
 * sees the room.
 */

/** The display traits of one person, from their profile. */
export interface DisplayTraits {
  /** this-or-that answers, question slug → "a" | "b". */
  answers: Readonly<Record<string, string>>
  languages: readonly string[]
  homeState: string | null
  /** Their pick, or null — never derived. */
  sign: { slug: string; system: SignSystem | string } | null
}

export const NO_TRAITS: DisplayTraits = { answers: {}, languages: [], homeState: null, sign: null }

/** `interest` is for crew cards only: a person card already lists shared interests as chips. */
export type OverlapKind = "interest" | "ipl" | "this_or_that" | "language" | "home_state" | "sign"

export interface Overlap {
  kind: OverlapKind
  /** The sentence, ready to print. */
  text: string
}

/** The keys a person holds, each counted once per person in a room. */
export function traitKeys(t: DisplayTraits): string[] {
  const keys = new Set<string>()
  for (const [q, c] of Object.entries(t.answers)) keys.add(`tot:${answerKey(q, c)}`)
  for (const l of t.languages) keys.add(`lang:${l}`)
  if (t.homeState) keys.add(`state:${t.homeState}`)
  const sign = signOf(t.sign?.slug)
  if (sign) {
    keys.add(`sign:${sign.slug}`)
    keys.add(`element:${sign.element}`)
  }
  return [...keys]
}

/** How many in a room hold each display trait. */
export function traitHolders(people: readonly DisplayTraits[]): Map<string, number> {
  const holders = new Map<string, number>()
  for (const p of people) for (const k of traitKeys(p)) holders.set(k, (holders.get(k) ?? 0) + 1)
  return holders
}

const LANGUAGE_LABEL = new Map(LANGUAGES.map((l) => [l.slug, l.label]))
const TEAM = new Map(IPL_TEAMS.map((t) => [t.code, t]))

const WESTERN_PLURAL: Record<string, string> = {
  aries: "Aries",
  taurus: "Taureans",
  gemini: "Geminis",
  cancer: "Cancerians",
  leo: "Leos",
  virgo: "Virgos",
  libra: "Libras",
  scorpio: "Scorpios",
  sagittarius: "Sagittarians",
  capricorn: "Capricorns",
  aquarius: "Aquarians",
  pisces: "Pisceans",
}

/** The IPL team most people in the room hold, if one leads outright. */
export function roomTeam(
  iplTeams: ReadonlyMap<string, string>,
  interestHolders: ReadonlyMap<string, number>
): string | null {
  let best: { code: string; n: number } | null = null
  let tied = false
  for (const [id, code] of iplTeams) {
    const n = interestHolders.get(id) ?? 0
    if (n === 0) continue
    if (!best || n > best.n) {
      best = { code, n }
      tied = false
    } else if (n === best.n) tied = true
  }
  return best && !tied ? best.code : null
}

/** "Both CSK — in RCB country 💛", or "Both RCB fans ❤️" when the team is the room's own. */
export function iplLine(code: string, inRoomOf: string | null): string {
  const heart = TEAM.get(code)?.heart ?? ""
  return inRoomOf && inRoomOf !== code
    ? `Both ${code} — in ${inRoomOf} country ${heart}`.trim()
    : `Both ${code} fans ${heart}`.trim()
}

function signLine(viewer: DisplayTraits["sign"], them: DisplayTraits["sign"]): { key: string; text: string } | null {
  const a = signOf(viewer?.slug)
  const b = signOf(them?.slug)
  if (!a || !b) return null
  if (a.slug === b.slug) {
    if (viewer?.system === them?.system) {
      const name = viewer?.system === "rashi" ? a.rashi : WESTERN_PLURAL[a.slug]
      return { key: `sign:${a.slug}`, text: `Both ${name} ${a.symbol} — the stars approve` }
    }
    // One picked Western and the other their rashi: the same sign, two calendars.
    return { key: `sign:${a.slug}`, text: `${a.western} and ${a.rashi} — same sign, two calendars ${a.symbol}` }
  }
  if (a.element === b.element) return { key: `element:${a.element}`, text: `Two ${a.element} signs ${ELEMENT_EMOJI[a.element]}` }
  return null
}

interface Candidate extends Label {
  kind: OverlapKind
  text: string
}

/**
 * The display lines one card may print about two people, ordered and budgeted.
 *
 * `max` lines in all; `tierB` of them origin-like (`tierBBudget`). Ordered by
 * rarity in the room, so the line that tells you most about this pair leads.
 */
export function personOverlaps(
  viewer: { traits: DisplayTraits; interestIds: readonly string[] },
  them: { traits: DisplayTraits; interestIds: readonly string[] },
  room: {
    holders: ReadonlyMap<string, number>
    interestHolders: ReadonlyMap<string, number>
    population: number
    /** IPL leaf category id → team code. */
    iplTeams: ReadonlyMap<string, string>
    roomTeam: string | null
  },
  budget: { max: number; tierB: number }
): Overlap[] {
  const w = (key: string) => interestWeight(key, room.holders, room.population)
  const lines: Candidate[] = []

  const theirInterests = new Set(them.interestIds)
  for (const id of viewer.interestIds) {
    const code = room.iplTeams.get(id)
    if (code && theirInterests.has(id)) {
      lines.push({
        kind: "ipl",
        tier: "A",
        weight: interestWeight(id, room.interestHolders, room.population),
        text: iplLine(code, room.roomTeam),
      })
    }
  }

  for (const [q, c] of Object.entries(viewer.traits.answers)) {
    if (them.traits.answers[q] !== c) continue
    const p = picked(q, c)
    if (p) {
      lines.push({
        kind: "this_or_that",
        tier: "A",
        weight: w(`tot:${answerKey(q, c)}`),
        text: `You both picked ${p.chose.phrase} over ${p.over.phrase}`,
      })
    }
  }

  const theirLanguages = new Set(them.traits.languages)
  for (const l of viewer.traits.languages) {
    if (!theirLanguages.has(l) || !LANGUAGE_LABEL.has(l)) continue
    lines.push({
      kind: "language",
      tier: "B",
      weight: w(`lang:${l}`),
      text: l === "kannada_learning" ? "You're both learning Kannada" : `You both speak ${LANGUAGE_LABEL.get(l)}`,
    })
  }

  const state = viewer.traits.homeState
  if (state && state === them.traits.homeState && homeStateLabel(state)) {
    lines.push({
      kind: "home_state",
      tier: "B",
      weight: w(`state:${state}`),
      text: state === "abroad" ? "You both grew up abroad" : `Both from ${homeStateLabel(state)}`,
    })
  }

  const sign = signLine(viewer.traits.sign, them.traits.sign)
  if (sign) lines.push({ kind: "sign", tier: "B", weight: w(sign.key), text: sign.text })

  return orderLabels(lines, budget).map(({ kind, text }) => ({ kind, text }))
}

/**
 * Their own sign as a chip — "Leo ♌" — when they chose to show one and the
 * card has Tier B left after its overlap lines. Not when a sign line already
 * said it, and never in a room the budget keeps origin-like facts out of: a
 * sign beside an age narrows a birthday to a month (§2.2 of the research).
 */
export function signChip(
  them: DisplayTraits,
  overlaps: readonly Overlap[],
  budget: { tierB: number }
): string | null {
  const sign = signOf(them.sign?.slug)
  if (!sign) return null
  const tierBUsed = overlaps.filter((o) => o.kind === "language" || o.kind === "home_state" || o.kind === "sign")
  if (tierBUsed.some((o) => o.kind === "sign") || tierBUsed.length >= budget.tierB) return null
  return `${them.sign?.system === "rashi" ? sign.rashi : sign.western} ${sign.symbol}`
}

/* -------------------------------------------------------------------------- */
/* Badges you cannot buy (§8.6)                                                */
/* -------------------------------------------------------------------------- */

/** "Regular here": nights at this venue in the window. The Swarm window. */
export const REGULAR_HERE_NIGHTS = 3
export const REGULAR_HERE_DAYS = 60
/** "Shows up": share of past RSVPs attended, over at least this many. */
export const SHOWS_UP_RATE = 0.8
export const SHOWS_UP_MIN_RSVPS = 3
export const SHOWS_UP_DAYS = 90
/** "5+ nights this month": a tier, never a count. */
export const NIGHTS_OUT_TIER = 5
export const NIGHTS_OUT_DAYS = 30

/** `nights_together` is a crew's (lib/crews/signals.ts). */
export type BadgeKind = "regular_here" | "shows_up" | "nights_out" | "nights_together"

export interface Badge {
  kind: BadgeKind
  label: string
}

/** What a person's check-ins earned. Zero for anything not measured. */
export interface BadgeFacts {
  /** Nights checked in at this venue in `REGULAR_HERE_DAYS`; null at an event with no venue. */
  nightsHere: number | null
  /** Nights out anywhere in `NIGHTS_OUT_DAYS`. */
  nightsOut: number
  /** Past events they said they were going to, in `SHOWS_UP_DAYS`. */
  rsvpsPast: number
  /** Of those, the ones they checked in at. */
  rsvpsAttended: number
  /** "Shows up" is shown only to people who turned it on. */
  showsUpOptIn: boolean
}

/**
 * Badges from GPS check-ins — nothing typed, nothing bought. Derived on
 * read, never stored, so they cannot drift from what happened.
 *
 * "Regular here" is only ever about the venue both people are standing in:
 * it says how often, never where else. "Shows up" is opt-in, as Hinge's
 * Signals are. The nights-out badge is a tier, so it is a brag rather than a
 * tally — and there is no streak, which would reward going out compulsively.
 */
export function badgesFor(f: BadgeFacts): Badge[] {
  const out: Badge[] = []
  if (f.nightsHere !== null && f.nightsHere >= REGULAR_HERE_NIGHTS) out.push({ kind: "regular_here", label: "Regular here" })
  if (f.showsUpOptIn && f.rsvpsPast >= SHOWS_UP_MIN_RSVPS && f.rsvpsAttended / f.rsvpsPast >= SHOWS_UP_RATE) {
    out.push({ kind: "shows_up", label: "Shows up" })
  }
  if (f.nightsOut >= NIGHTS_OUT_TIER) out.push({ kind: "nights_out", label: `${NIGHTS_OUT_TIER}+ nights this month` })
  return out
}

/* -------------------------------------------------------------------------- */
/* What a crew holds (§8.3, crew ↔ crew and crew ↔ person)                     */
/* -------------------------------------------------------------------------- */

/**
 * A crew holds a trait when enough of its members do that it is the crew's
 * taste and not one person's: two at least, and a third of the crew. One
 * member's interest on a crew card would point at that member.
 */
export function crewHoldsAt(size: number): number {
  return Math.max(2, Math.ceil(size / 3))
}

/** One member, as the crew rules read them: interests (expanded) and display traits. */
export interface MemberTraits {
  interestIds: readonly string[]
  traits: DisplayTraits
}

/**
 * The keys a crew holds: interest ids, `lang:` and `state:` keys held by
 * `crewHoldsAt` members, and this-or-that answers held that often **and** by
 * a majority of those who answered. Never a count, never a member.
 */
export function crewHeld(members: readonly MemberTraits[]): Set<string> {
  const need = crewHoldsAt(members.length)
  const counts = new Map<string, number>()
  const bump = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1)
  for (const m of members) {
    for (const id of new Set(m.interestIds)) bump(id)
    for (const l of new Set(m.traits.languages)) bump(`lang:${l}`)
    if (m.traits.homeState) bump(`state:${m.traits.homeState}`)
    for (const [q, c] of Object.entries(m.traits.answers)) bump(`tot:${answerKey(q, c)}`)
  }
  const held = new Set<string>()
  for (const [k, n] of counts) {
    if (n < need) continue
    if (k.startsWith("tot:")) {
      const [q, c] = k.slice(4).split(":")
      const other = counts.get(`tot:${answerKey(q, c === "a" ? "b" : "a")}`) ?? 0
      if (n <= other) continue
    }
    held.add(k)
  }
  return held
}

/** A person's own keys, in the shape `crewHeld` returns, for crew ↔ person. */
export function personKeys(m: MemberTraits): Set<string> {
  const keys = new Set<string>(m.interestIds)
  for (const l of m.traits.languages) keys.add(`lang:${l}`)
  if (m.traits.homeState) keys.add(`state:${m.traits.homeState}`)
  for (const [q, c] of Object.entries(m.traits.answers)) keys.add(`tot:${answerKey(q, c)}`)
  return keys
}

/** Crews this much bigger than the other are a mismatch (Timeleft balances its tables). */
export const SIZE_BALANCE_RATIO = 2
export const SIZE_IMBALANCE_DAMPING = 0.5

/** 1 for crews within 2:1 of each other, damped beyond; 1 for a person (no balance to keep). */
export function sizeBalance(mine: number | null, theirs: number): number {
  if (mine === null || mine <= 0 || theirs <= 0) return 1
  return Math.max(mine, theirs) / Math.min(mine, theirs) > SIZE_BALANCE_RATIO ? SIZE_IMBALANCE_DAMPING : 1
}

export interface CrewOverlapRoom {
  /** How many crews here hold each key — rarity across crews. */
  holders: ReadonlyMap<string, number>
  population: number
  parentOf: ReadonlyMap<string, string>
  categoryName: ReadonlyMap<string, string>
  iplTeams: ReadonlyMap<string, string>
  /**
   * Origin-like lines (languages, home state) only when both sides are four or
   * more here **and** the room is eight or more (§8.3) — a crew of two "has
   * Kerala folks" names both of them.
   */
  tierBAllowed: boolean
}

/**
 * The lines a crew card prints for its viewer, and the interest weight that
 * ranks it. `mine` is the viewer's own crew's held keys, or the solo viewer's
 * own keys (`solo: true`) — "This crew is into techno, like you".
 */
export function crewOverlaps(
  mine: ReadonlySet<string>,
  theirs: ReadonlySet<string>,
  solo: boolean,
  room: CrewOverlapRoom
): { overlaps: Overlap[]; interestScore: number } {
  const shared = [...mine].filter((k) => theirs.has(k))
  const w = (k: string) => interestWeight(k, room.holders, room.population)
  const lines: Candidate[] = []
  let interestScore = 0

  const interests = collapseToMostSpecific(
    shared.filter((k) => !k.includes(":")),
    room.parentOf
  )
  for (const id of interests) {
    const weight = w(id)
    interestScore += weight
    const code = room.iplTeams.get(id)
    if (code) {
      const heart = TEAM.get(code)?.heart ?? ""
      lines.push({
        kind: "ipl",
        tier: "A",
        weight,
        text: (solo ? `A ${code} crew, and you're ${code} ${heart}` : `Two ${code} crews ${heart}`).trim(),
      })
      continue
    }
    const name = room.categoryName.get(id)
    if (name) lines.push({ kind: "interest", tier: "A", weight, text: solo ? `This crew is into ${name}, like you` : `Both crews are into ${name}` })
  }

  for (const k of shared) {
    if (k.startsWith("tot:")) {
      const [q, c] = k.slice(4).split(":")
      const p = picked(q, c)
      if (p) {
        lines.push({
          kind: "this_or_that",
          tier: "A",
          weight: w(k),
          text: solo
            ? `This crew picks ${p.chose.phrase} over ${p.over.phrase}, like you`
            : `Both crews pick ${p.chose.phrase} over ${p.over.phrase}`,
        })
      }
    } else if (k.startsWith("lang:")) {
      const label = LANGUAGE_LABEL.get(k.slice(5))
      if (label) {
        lines.push({
          kind: "language",
          tier: "B",
          weight: w(k),
          text: solo ? `This crew has ${label} speakers, like you` : `Both crews have ${label} speakers`,
        })
      }
    } else if (k.startsWith("state:")) {
      const slug = k.slice(6)
      const label = homeStateLabel(slug)
      if (label) {
        const folks = slug === "abroad" ? "folks who grew up abroad" : `folks from ${label}`
        lines.push({ kind: "home_state", tier: "B", weight: w(k), text: solo ? `This crew has ${folks}, like you` : `Both crews have ${folks}` })
      }
    }
  }

  const overlaps = orderLabels(lines, { max: 2, tierB: room.tierBAllowed ? 1 : 0 }).map(({ kind, text }) => ({ kind, text }))
  return { overlaps, interestScore }
}
