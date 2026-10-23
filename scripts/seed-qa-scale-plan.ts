import { createHash } from "crypto"

/**
 * The shape of the scale world `seed-qa-scale.ts` writes: how many of what, and
 * who is whom. Pure (no database), so the counts, the ids and the one-person-
 * one-role layout are unit-tested.
 *
 * ## The tag
 *
 * `profiles` and `User` have no QA flag, so the tag is the identity itself:
 * every crowd user's id starts `qascale_` and its address is
 * `qa.scale.NNNN@blendn.app`. Everything else the seed makes is either owned by
 * one of those users (and goes with them: friendships, requests, DMs, messages,
 * check-ins, sessions, RSVPs, board posts all cascade from `User`) or carries
 * the `qa-scale-` slug / `qa-scale` source below. `--remove` deletes by those
 * and nothing else.
 *
 * Every row id is derived from a key (`uuidFor`), so a second `--apply` meets
 * the rows it made and skips them instead of duplicating them.
 */

export const ID_PREFIX = "qascale_"
export const EVENT_SLUG_PREFIX = "qa-scale-"
export const VENUE_SOURCE = "qa-scale"
/** Written into `event_check_ins.device_info`, so a target's own rows are findable. */
export const CHECK_IN_TAG = { qaScale: true } as const
/** `entitlements.external_ref` of a QA comp: unique per person, and unmistakably ours. */
export const PLUS_REF_PREFIX = "qa-scale-plus:"
/** Only addresses that are unmistakably throwaways may be given a comp. */
export const PLUS_ALLOWED_PREFIX = "qa."
const PLUS_ALLOWED_DOMAIN = "@blendn.app"

/** Why this address may not be comped, or null when it is a throwaway of ours. */
export function plusCompRefusal(email: string): string | null {
  return email.startsWith(PLUS_ALLOWED_PREFIX) && email.endsWith(PLUS_ALLOWED_DOMAIN)
    ? null
    : `Refusing to comp ${email}: only throwaway ${PLUS_ALLOWED_PREFIX}*${PLUS_ALLOWED_DOMAIN} accounts.`
}

export const TARGET_EMAILS = ["qa.rc.a@blendn.app", "qa.rc.b@blendn.app", "qa.rc.c@blendn.app"] as const

export const PER_TARGET = {
  /** Accepted friendships. */
  friends: 1000,
  /** Friends checked in to the big event, listed in Friends here. */
  bigRoomFriends: 60,
  /** Friends checked in to the second event. */
  secondRoomFriends: 4,
  /** Friends with a DM thread (so the inbox pages past one 50-row page). */
  friendDms: 60,
  /** Pending message requests (the list's page is 20, its cap 50). */
  messageRequests: 60,
  /** Pending incoming friend requests (a page is 50). */
  friendRequests: 60,
  /** Past events with matches to rate, and how many matches in each. */
  ratedNights: 3,
  matchesPerNight: 6,
  /** Upcoming events they are going to: past one page, at a venue past the Coming up cap of 5. */
  goingEvents: 35,
  /** Past nights attended, with an RSVP each. */
  pastNights: 36,
  /** Venue-day visits (Go Live), each on a different local day. */
  visits: 8,
} as const

/** Non-friend crowd users checked in to the big event: the concert-scale grid. */
export const ROOM_STRANGERS = 300
/** Board posts in the big event's room (a page is 100). */
export const BOARD_POSTS = 120

export const pad4 = (n: number) => String(n).padStart(4, "0")
export const crowdId = (n: number) => `${ID_PREFIX}${pad4(n)}`
export const crowdEmail = (n: number) => `qa.scale.${pad4(n)}@blendn.app`

/** A UUID from a key: the same key is the same id on every run (v4-shaped, so the column accepts it). */
export function uuidFor(key: string): string {
  const h = createHash("sha256").update(`qa-scale:${key}`).digest("hex")
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** The pair in the order the database's CHECKs hold: byte order (COLLATE "C"), which is `<` on these ASCII ids. */
export const canonicalPair = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a])

const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i)

/**
 * Who is whom, by crowd index. One person has one role, so a friend is never
 * also a stranger in the room, and nobody who has asked for a DM is already a
 * friend. Index 0 is the host that owns the QA events.
 */
export interface TargetLayout {
  /** `bigRoomFriends` first, then `secondRoomFriends`, then DM friends, then the rest. */
  friends: number[]
  messageRequesters: number[]
  friendRequesters: number[]
  /** `ratedNights` groups of `matchesPerNight`. */
  matchPeers: number[][]
}

export interface Layout {
  host: number
  strangers: number[]
  targets: TargetLayout[]
  /** Highest index + 1: how many crowd users there are. */
  size: number
}

export function layoutFor(targetCount: number): Layout {
  const p = PER_TARGET
  let next = 1
  const take = (n: number) => {
    const out = range(next, n)
    next += n
    return out
  }
  const friendsByTarget = Array.from({ length: targetCount }, () => take(p.friends))
  const strangers = take(ROOM_STRANGERS)
  const targets = friendsByTarget.map((friends) => ({
    friends,
    messageRequesters: take(p.messageRequests),
    friendRequesters: take(p.friendRequests),
    matchPeers: Array.from({ length: p.ratedNights }, () => take(p.matchesPerNight)),
  }))
  return { host: 0, strangers, targets, size: next }
}

/** Where a friend sits in a target's friend list tells what they are for. */
export function friendSlices(friends: readonly number[]) {
  const p = PER_TARGET
  return {
    bigRoom: friends.slice(0, p.bigRoomFriends),
    secondRoom: friends.slice(p.bigRoomFriends, p.bigRoomFriends + p.secondRoomFriends),
    dm: friends.slice(p.bigRoomFriends + p.secondRoomFriends, p.bigRoomFriends + p.secondRoomFriends + p.friendDms),
  }
}

/** Every crowd index that turns on `friends_see_me_in_rooms`: the people Friends here may list. */
export function listableFriends(layout: Layout): Set<number> {
  const out = new Set<number>()
  for (const t of layout.targets) {
    const s = friendSlices(t.friends)
    for (const i of [...s.bigRoom, ...s.secondRoom]) out.add(i)
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* People                                                                      */
/* -------------------------------------------------------------------------- */

const FIRST = {
  woman: ["Aanya", "Diya", "Ira", "Kavya", "Meera", "Nisha", "Riya", "Saanvi", "Tara", "Veda", "Anika", "Bhavna", "Charu", "Deepa", "Esha", "Farah", "Gauri", "Hema", "Isha", "Jaya"],
  man: ["Aarav", "Dev", "Ishaan", "Kabir", "Neel", "Rohan", "Sahil", "Varun", "Yash", "Zain", "Arnav", "Bharat", "Chirag", "Dhruv", "Eshan", "Farhan", "Gautam", "Harsh", "Imran", "Jai"],
} as const
const LAST = ["Sharma", "Iyer", "Rao", "Nair", "Menon", "Gowda", "Reddy", "Kulkarni", "Shetty", "Bhat", "Patel", "Shah", "Khan", "Mehta", "Joshi", "Pillai", "Hegde", "Kamath", "Naidu", "Desai", "Bose", "Das", "Kapoor", "Malhotra"]
const AREAS = ["Indiranagar", "Koramangala", "HSR Layout", "Jayanagar", "Whitefield", "Malleshwaram", "Basavanagudi", "Hebbal", "Domlur", "Bellandur"]
const INTERESTS = ["Live music", "Design", "Coffee", "Running", "Board games", "Photography", "Food walks", "Comedy", "Cycling", "Books", "Startups", "Film", "Pottery", "Climbing", "Techno", "Yoga"]
const INTENTS = [["friendship"], ["networking"], ["friendship", "networking"], ["dating", "friendship"], ["just_here"]] as const

export interface Person {
  index: number
  id: string
  email: string
  name: string
  gender: "woman" | "man"
  age: number
  area: string
  interests: string[]
  intents: string[]
  /** An index into the portrait list of this gender. */
  portrait: number
}

export function personFor(index: number): Person {
  const gender = index % 2 === 0 ? "woman" : "man"
  const names = FIRST[gender]
  const first = names[Math.floor(index / 2) % names.length]
  const last = LAST[(index * 7 + Math.floor(index / names.length / 2)) % LAST.length]
  return {
    index,
    id: crowdId(index),
    email: crowdEmail(index),
    name: `${first} ${last}`,
    gender,
    age: 21 + (index % 20),
    area: AREAS[index % AREAS.length],
    interests: [0, 5, 11].map((k) => INTERESTS[(index + k) % INTERESTS.length]),
    intents: [...INTENTS[index % INTENTS.length]],
    portrait: index,
  }
}

/* -------------------------------------------------------------------------- */
/* Texts                                                                       */
/* -------------------------------------------------------------------------- */

export const DM_LINES = [
  "Are you going tonight?",
  "Saved you a seat near the front.",
  "That set was unreal, thanks for the tip.",
  "Coffee on Sunday?",
  "Sending the photos from last week now.",
  "Running ten minutes late, sorry!",
  "Bring a jacket, it gets cold on the terrace.",
  "Did you see who is playing next month?",
] as const

export const REQUEST_LINES = [
  "Hi! We were at the same table last week.",
  "Loved your take on the panel, can we chat?",
  "Saw you at the design night — would love to swap notes.",
  "Hey, a friend said you run the Sunday ride?",
] as const

export const BOARD_LINES = [
  ["offer", "Two spare seats in my cab from Indiranagar, leaving at 8."],
  ["seeking", "Anyone going alone? Looking for people to stand with near the stage."],
  ["chat", "First time here, what is the best spot to hear the set?"],
  ["offer", "I have a spare plus-one for the rooftop after party."],
  ["seeking", "Need a ride back to Koramangala after 11, will split the fare."],
  ["chat", "Is the queue at the east gate moving?"],
] as const

/* -------------------------------------------------------------------------- */
/* Counts                                                                      */
/* -------------------------------------------------------------------------- */

/** What a full apply writes for this many targets, for the dry run and the tests to say the same thing. */
export function plannedCounts(targetCount: number) {
  const p = PER_TARGET
  const layout = layoutFor(targetCount)
  const t = targetCount
  return {
    crowdUsers: layout.size,
    friendships: t * p.friends,
    friendRequests: t * p.friendRequests,
    messageRequests: t * p.messageRequests,
    conversations: t * (p.friendDms + p.ratedNights * p.matchesPerNight),
    bigRoomCheckIns: t + t * p.bigRoomFriends + ROOM_STRANGERS,
    secondRoomCheckIns: t * p.secondRoomFriends,
    boardPosts: BOARD_POSTS,
    goingRsvps: t * p.goingEvents,
    pastNights: t * p.pastNights,
    visits: t * p.visits,
    events: p.goingEvents + p.pastNights + p.visits,
  }
}
