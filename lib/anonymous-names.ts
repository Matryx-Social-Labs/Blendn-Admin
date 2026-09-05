import { db } from "./db"

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
export function preferredPseudonymFor(eventId: string, userId: string): string {
  // FNV-1a. Not a security boundary — it needs to be stable and spread, and it
  // must never be a user id, which is the property `pseudonymAvatar.ts` states
  // in as many words: a user id is stable forever and rebuilds the cross-event
  // identity the pseudonyms exist to prevent.
  let h = 0x811c9dc5
  const seed = `${eventId}:${userId}`
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  // Two independent draws from one hash: the low half picks the adjective, the
  // high half the noun, so a shared prefix does not collapse both.
  return `${ADJECTIVES[(h & 0xffff) % ADJECTIVES.length]} ${NOUNS[(h >>> 16) % NOUNS.length]}`
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
    const preferred = preferredPseudonymFor(preferFor.eventId, preferFor.userId)
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
