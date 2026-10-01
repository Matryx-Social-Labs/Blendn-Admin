import { createHmac, hkdfSync } from "crypto"

import { isUuid } from "./api-input"
import { db } from "./db"
import { violatedConstraint } from "./prisma-errors"

const ADJECTIVES = [
  "Cosmic", "Neon", "Electric", "Golden", "Silver", "Crystal", "Mystic",
  "Lunar", "Solar", "Stellar", "Arctic", "Tropical", "Velvet", "Crimson",
  "Emerald", "Sapphire", "Ruby", "Amber", "Jade", "Coral", "Ivory",
  "Midnight", "Twilight", "Dawn", "Dusk", "Shadow", "Phantom", "Radiant",
  "Vivid", "Bold", "Brave", "Swift", "Gentle", "Fierce", "Noble", "Wild",
  "Silent", "Stormy", "Sunny", "Misty", "Frosty", "Blazing", "Gleaming",
  "Hidden", "Lucky", "Clever", "Witty", "Dreamy", "Daring", "Mellow",
  "Rustic", "Urban", "Wandering", "Floating", "Dancing", "Singing",
  "Laughing", "Glowing", "Sparkling", "Shining", "Burning", "Roaming",
  "Soaring", "Drifting", "Rolling", "Spinning", "Whirling", "Rising",
  "Falling", "Leaping", "Bouncing", "Tumbling", "Flowing", "Rushing",
  "Crashing", "Rumbling", "Humming", "Buzzing", "Chirping", "Howling",
]

const NOUNS = [
  "Panda", "Phoenix", "Dragon", "Falcon", "Tiger", "Wolf", "Eagle",
  "Dolphin", "Panther", "Jaguar", "Hawk", "Raven", "Owl", "Fox",
  "Bear", "Lion", "Stag", "Cobra", "Viper", "Crane", "Swan",
  "Otter", "Badger", "Lynx", "Moose", "Bison", "Gecko", "Mantis",
  "Heron", "Robin", "Finch", "Wren", "Lark", "Dove", "Parrot",
  "Toucan", "Pelican", "Puffin", "Penguin", "Koala", "Lemur",
  "Coyote", "Gazelle", "Cheetah", "Mustang", "Stallion", "Pegasus",
  "Griffin", "Unicorn", "Sphinx", "Kraken", "Hydra", "Titan",
  "Comet", "Nebula", "Quasar", "Nova", "Meteor", "Orbit", "Zenith",
  "Prism", "Echo", "Spark", "Flame", "Blaze", "Storm", "Thunder",
  "Frost", "Glacier", "Reef", "Oasis", "Summit", "Canyon", "Ridge",
  "Meadow", "Grove", "Brook", "River", "Tide", "Wave", "Dune",
]

/**
 * The handle a person should get at an event, before anybody has minted one.
 *
 * ## Why this is derived rather than stored
 *
 * A pseudonym and a room membership are the same row today —
 * `chat_group_members` carries `anonymous_name`, and `canJoinChat` grants the
 * socket room to any member who is not banned. So there is no way to give
 * somebody a handle without also giving them the live room, and the live room
 * is gated on presence deliberately: doors close on people who did not come.
 *
 * The board needs a handle and must not grant the room. Deriving it from
 * `(event_id, user_id)` gives one that is stable for that person at that
 * event, different at the next event, and costs no row and no table.
 *
 * **This matters more than it looks.** Without it a board conversation has
 * null pseudonyms, and `displayNameInConversation` falls back to the real name
 * when there is no pseudonym — so two people who agreed to share a car would
 * see each other's real names, which is the one disclosure this product exists
 * to prevent.
 *
 * Not unique by construction: ~6,480 combinations, so a board of tens can
 * collide. `generateUniqueAnonymousName` treats it as a *preference* and falls
 * back where it is taken, which is where uniqueness is actually enforced.
 */
export function preferredPseudonymFor(eventId: string, userId: string, scheme: PseudonymScheme): string {
  const seed = `${eventId}:${userId}`
  const h = scheme === "keyed" ? keyedHash(seed) : fnv1a(seed)
  // Two independent draws from one hash: the low half picks the adjective, the
  // high half the noun, so a shared prefix does not collapse both.
  return `${ADJECTIVES[(h & 0xffff) % ADJECTIVES.length]} ${NOUNS[(h >>> 16) % NOUNS.length]}`
}

/**
 * Which derivation an event's handles use.
 *
 * `legacy` was FNV-1a of `eventId:userId`, unkeyed: anybody holding a
 * candidate's account id — a friend, from the friends list — could compute
 * their handle at an event and find them on its board (SCRUM-517). `keyed` is
 * an HMAC under a key derived from `NEXTAUTH_SECRET`, as `lib/room-handle.ts`
 * derives its own, so only the server can.
 *
 * By the event's creation, not switched for everyone at once: a board name is
 * derived live until check-in stores one, so changing the hash under an event
 * already running would rename everybody who has posted on its board — and
 * the person they arranged to travel with could no longer find them. Events
 * created before `KEYED_PSEUDONYMS_FROM` keep the old names until they end.
 */
export type PseudonymScheme = "keyed" | "legacy"

export const KEYED_PSEUDONYMS_FROM = new Date("2026-10-02T00:00:00.000Z")

export async function pseudonymSchemeFor(eventId: string): Promise<PseudonymScheme> {
  // Not a uuid, not an event: the column refuses it, and a refusal here would
  // fail check-in over a name. The key is the safe side.
  if (!isUuid(eventId)) return "keyed"
  const event = await db.events.findUnique({ where: { id: eventId }, select: { created_at: true } })
  // An event that cannot be found has no board to keep stable; the key is the safe side.
  return event && event.created_at < KEYED_PSEUDONYMS_FROM ? "legacy" : "keyed"
}

function fnv1a(seed: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

let pseudonymKey: { secret: string; key: Buffer } | null = null

function keyedHash(seed: string): number {
  const secret = process.env.NEXTAUTH_SECRET
  // Loudly, like the room handles: an empty key is the unkeyed hash again.
  if (!secret) throw new Error("NEXTAUTH_SECRET is required to derive pseudonyms")
  if (pseudonymKey?.secret !== secret) {
    pseudonymKey = {
      secret,
      key: Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), "blendn preferred-pseudonym v1", 32)),
    }
  }
  return createHmac("sha256", pseudonymKey.key).update(seed).digest().readUInt32BE(0)
}

/**
 * @param preferFor Who to derive a preference for — the handle this person
 *   already goes by at this event, which the board has been showing them under
 *   since before doors. Used when free, so somebody who posted on the board and
 *   then checks in keeps the name people answered. Without it the room renames
 *   them on arrival, and the person they arranged to travel with cannot find
 *   them.
 *
 *   **Two ids, not a string, and that is the whole safety of the parameter.**
 *   A first draft took the preferred name as text, and
 *   `conversation-identity.test.ts` failed it immediately: this generator's
 *   guarantee is that it can only ever emit `Adjective Noun` from two fixed
 *   word lists, so there is no input to leak — and a free string parameter
 *   hands that guarantee to every caller, one of which will eventually pass
 *   `profile.name`. Deriving inside keeps the output structurally incapable of
 *   containing a real name.
 */
export async function generateUniqueAnonymousName(
  chatGroupId: string,
  preferFor?: { eventId: string; userId: string }
): Promise<string> {
  // Fetch existing anonymous names in this group
  const existingMembers = await db.chat_group_members.findMany({
    where: { chat_group_id: chatGroupId },
    select: { anonymous_name: true },
  })

  const existingNames = new Set(
    existingMembers
      .map((m) => m.anonymous_name)
      .filter((n): n is string => n !== null)
  )

  if (preferFor) {
    const preferred = preferredPseudonymFor(
      preferFor.eventId,
      preferFor.userId,
      await pseudonymSchemeFor(preferFor.eventId)
    )
    if (!existingNames.has(preferred)) return preferred
  }

  // Try random combos up to 20 times
  for (let i = 0; i < 20; i++) {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
    const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]
    const name = `${adj} ${noun}`
    if (!existingNames.has(name)) {
      return name
    }
  }

  // Fallback: append a number suffix
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]
  for (let suffix = 2; suffix < 1000; suffix++) {
    const name = `${adj} ${noun} ${suffix}`
    if (!existingNames.has(name)) {
      return name
    }
  }

  return `Attendee ${Date.now()}`
}

/**
 * Everyone's pseudonym in an event's room, keyed by user id.
 *
 * The room is pseudonymous everywhere it is rendered — group chat, the
 * participants list, the socket payloads, the dashboard. The attendee list was
 * the exception: it returned real names and photos to any authenticated caller,
 * so the anonymity was readable straight out of the network tab.
 *
 * One pseudonym per person per event, so the name in the attendee list is the
 * same name in the chatroom. Two identities for one person in one room would be
 * worse than none — it would let someone be recognised in chat and not in the
 * list, or the reverse.
 *
 * Falls back to "Attendee" rather than to the real name. A missing pseudonym is
 * a bug, and degrading to the thing we are trying not to disclose turns that bug
 * into a disclosure.
 */
export async function pseudonymsForEvent(eventId: string): Promise<Map<string, string>> {
  const members = await db.chat_group_members.findMany({
    where: { chat_group: { event_id: eventId } },
    select: { user_id: true, anonymous_name: true },
  })
  return new Map(members.map((m) => [m.user_id, m.anonymous_name || "Attendee"]))
}

/**
 * One person's pseudonym in one event's room — `pseudonymsForEvent` for a
 * single card, without loading the whole room. Same "Attendee" fallback, for
 * the same reason.
 */
export async function roomPseudonymOf(eventId: string, userId: string): Promise<string> {
  const member = await db.chat_group_members.findFirst({
    where: { chat_group: { event_id: eventId }, user_id: userId },
    select: { anonymous_name: true },
  })
  return member?.anonymous_name || "Attendee"
}

/**
 * Mint a handle and persist it, retrying when somebody else took it first.
 *
 * ## The read is not a lock, and doors are when everyone arrives at once
 *
 * `generateUniqueAnonymousName` reads the names already in the group and picks
 * one that is free. The write happens afterwards, in a separate statement, and
 * `@@unique([chat_group_id, anonymous_name])` is what actually enforces it — so
 * two people checking in at the same moment can both read "Cosmic Panda is
 * free", and the second write raises `P2002` and comes back as a **500 on
 * check-in**: the product's core action, failing at the one minute of the night
 * when every attendee performs it.
 *
 * With ~6,480 combinations, the probability that *some* pair in a 200-person
 * room draws the same name is about 95%. This is not a rare race.
 *
 * The retry treats the constraint as the source of truth rather than the read,
 * which is the only ordering that is correct without a lock.
 *
 * ## Why a collision on the OTHER unique must not retry
 *
 * `chat_group_members` also has `@@unique([chat_group_id, user_id])`, and that
 * one means "you are already a member" — a state no amount of re-rolling a
 * name will resolve. Retrying it would spin five times and then throw the
 * wrong error. So the retry is scoped by inspecting which constraint failed,
 * and anything else is rethrown untouched.
 */
export async function claimAnonymousName<T>(
  chatGroupId: string,
  write: (anonymousName: string) => Promise<T>,
  preferFor?: { eventId: string; userId: string }
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < 5; attempt++) {
    const name = await generateUniqueAnonymousName(chatGroupId, preferFor)
    try {
      return await write(name)
    } catch (error) {
      if (!isAnonymousNameCollision(error)) throw error
      lastError = error
      /*
       * Drop the preference after the first miss. It is deterministic, so
       * re-deriving it would hand back the same taken name every time and burn
       * all five attempts on one collision.
       */
      preferFor = undefined
    }
  }
  throw lastError
}

/**
 * A unique violation on the name, and specifically not on the membership pair.
 *
 * `(chat_group_id, user_id)` means "you are already a member" — a state no
 * amount of re-rolling a name resolves — so retrying it would burn five rolls
 * and then throw the wrong error. The two are told apart by which constraint
 * the database named.
 *
 * `violatedConstraint` rather than a path into the error: this deployment's
 * Prisma reports the violated *fields* in `error.message` and the constraint
 * name only inside the driver adapter's nested cause, and that field has
 * already moved once between two configurations of this project. See
 * `lib/prisma-errors.ts`, where two handlers written the obvious way are
 * recorded as never having fired.
 */
function isAnonymousNameCollision(error: unknown): boolean {
  return violatedConstraint(error, "anonymous_name")
}
