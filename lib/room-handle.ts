import { createCipheriv, createDecipheriv, createHmac, hkdfSync, timingSafeEqual } from "crypto"
import type { chat_group_kind } from "@prisma/client"

/**
 * The id a room shows for somebody else (SCRUM-371).
 *
 * ## Why the id had to go
 *
 * The room is pseudonymous, and every room surface sent the **real user id**
 * beside the pseudonym. `lib/identity.ts` closed the lookup that turned an id
 * into a name, and said a per-event handle could wait. It could not wait for
 * friends: a friend has your real id (the friends list and a friend DM carry
 * it), so the roster, a message author or a check-in on the public counter
 * room told them which "Cosmic Panda" was you — past your
 * `friends_see_me_in_rooms` switch, which exists to prevent exactly that. The
 * same id let a stranger who saw you at two events know it was one person.
 *
 * ## What a handle is
 *
 * `rh_` + base64url(IV ‖ AES-256-GCM(eventId ‖ userId) ‖ tag), with the IV the
 * first 12 bytes of an HMAC over the plaintext — a synthetic IV, so:
 *
 * - **Deterministic.** One person is one handle for the whole of one room, so
 *   the roster, the chat and the socket agree and a client can match them.
 * - **Unlinkable across rooms.** The event is inside the plaintext, so the same
 *   person at two events is two unrelated strings.
 * - **Unforgeable.** GCM authenticates it; a flipped bit is not a different
 *   person, it is nobody.
 * - **Reversible without a lookup.** No table, no migration, nothing to
 *   expire — the key is the only state, which is also why rotating
 *   `NEXTAUTH_SECRET` retires every handle a client holds (they re-fetch).
 *
 * A synthetic IV repeats only for a repeated plaintext, which is the one
 * repetition wanted here; GCM's nonce-reuse failure needs two *different*
 * plaintexts under one IV, and that takes an HMAC-SHA256 prefix collision.
 *
 * ## The rule it serves
 *
 * Others are handles; **you are always your real id**. The app aligns its own
 * bubbles, spots its own check-in, drops its own typing and filters itself off
 * the roster by comparing with its own id, so those keep working unchanged.
 *
 * Keys come from `NEXTAUTH_SECRET` through HKDF, with separate labels for the
 * MAC and the cipher, as `lib/pseudonym.ts` reasons: `lib/env.ts` already
 * requires it at 32+ characters, and the mobile JWT key should not double as
 * an encryption key.
 *
 * ## Rooms of every kind (step 7, F9)
 *
 * A handle is scoped to one room, not to one event. An event's room is named
 * by its event id, exactly as before, so every handle an installed client
 * holds still resolves. A room of another kind (a crew, a Blend, a board
 * post) is named by its own group id **and its kind**: one byte after the id
 * that no account id can begin with, authenticated with the rest. So a handle
 * from one room never resolves in another, of the same kind or across kinds,
 * and the refusal does not rest on two random uuids happening to differ.
 *
 * Only an event room's handle resolves outside its room (`resolveUserRef`, for
 * the profile, friends and block routes). Who may recognise whom in a crew or
 * a Blend is the owner's rule, and those rooms do not have one yet; until they
 * do, their handles name somebody only inside the room that minted them
 * (`roomMemberFromRef`).
 */

const PREFIX = "rh_"
const IV_BYTES = 12
const TAG_BYTES = 16
const EVENT_BYTES = 16
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i

/**
 * The room a handle belongs to: an event's room by its event id (the encoding
 * every installed client holds), or a room of another kind by its group id.
 * `roomScope` in lib/room-kind.ts says which, from the room's row.
 */
export type RoomScope = string | { kind: Exclude<chat_group_kind, "event">; groupId: string }

/** After the id, for a room that is not an event's. Never the first byte of an account id (printable). */
const KIND_BYTE: Record<Exclude<chat_group_kind, "event">, number> = { crew: 1, blend: 2, board_post: 3 }
const KIND_OF_BYTE = new Map(Object.entries(KIND_BYTE).map(([kind, byte]) => [byte, kind as Exclude<chat_group_kind, "event">]))

function scopeBytes(scope: RoomScope): Buffer {
  const id = typeof scope === "string" ? scope : scope.groupId
  if (!UUID.test(id)) throw new Error("roomHandle needs a room uuid")
  const bytes = Buffer.from(id.replace(/-/g, ""), "hex")
  return typeof scope === "string" ? bytes : Buffer.concat([bytes, Buffer.from([KIND_BYTE[scope.kind]])])
}

const uuidOf = (hex: string) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`

function sameScope(a: RoomScope, b: RoomScope): boolean {
  if (typeof a === "string" || typeof b === "string") {
    return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase()
  }
  return a.kind === b.kind && a.groupId.toLowerCase() === b.groupId.toLowerCase()
}

let derived: { secret: string; mac: Buffer; enc: Buffer } | null = null

function keys(): { mac: Buffer; enc: Buffer } {
  const secret = process.env.NEXTAUTH_SECRET
  if (!secret) {
    // Loudly, like the pseudonyms: an empty key would make every handle
    // forgeable, which is worse than a room that fails to load.
    throw new Error("NEXTAUTH_SECRET is required to build room handles")
  }
  if (derived?.secret !== secret) {
    const key = (info: string) => Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), info, 32))
    derived = { secret, mac: key("blendn room-handle mac v1"), enc: key("blendn room-handle enc v1") }
  }
  return derived
}

function syntheticIv(mac: Buffer, plaintext: Buffer): Buffer {
  return createHmac("sha256", mac).update(plaintext).digest().subarray(0, IV_BYTES)
}

/** Another person's id as `scope`'s room shows it. Throws on a non-uuid room. */
export function roomHandle(scope: RoomScope, userId: string): string {
  const { mac, enc } = keys()
  const plaintext = Buffer.concat([scopeBytes(scope), Buffer.from(userId, "utf8")])
  const iv = syntheticIv(mac, plaintext)
  const cipher = createCipheriv("aes-256-gcm", enc, iv)
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return PREFIX + Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url")
}

export function isRoomHandle(ref: string): boolean {
  return ref.startsWith(PREFIX)
}

/** A handle's person and room, whatever kind of room. Null for anything that does not verify. */
function openHandle(ref: string): { userId: string; scope: RoomScope } | null {
  try {
    const raw = Buffer.from(ref.slice(PREFIX.length), "base64url")
    // base64url decoding skips what it cannot read, so re-encode to refuse
    // anything that was not exactly what `roomHandle` wrote.
    if (raw.toString("base64url") !== ref.slice(PREFIX.length)) return null
    if (raw.length <= IV_BYTES + EVENT_BYTES + TAG_BYTES) return null

    const { mac, enc } = keys()
    const iv = raw.subarray(0, IV_BYTES)
    const decipher = createDecipheriv("aes-256-gcm", enc, iv)
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES))
    const plaintext = Buffer.concat([decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), decipher.final()])
    // The IV must be the one `roomHandle` would have chosen — SIV's check.
    if (!timingSafeEqual(iv, syntheticIv(mac, plaintext))) return null

    const id = uuidOf(plaintext.subarray(0, EVENT_BYTES).toString("hex"))
    const kind = KIND_OF_BYTE.get(plaintext[EVENT_BYTES])
    const userId = plaintext.subarray(kind ? EVENT_BYTES + 1 : EVENT_BYTES).toString("utf8")
    if (!userId) return null
    return { userId, scope: kind ? { kind, groupId: id } : id }
  } catch {
    return null
  }
}

/**
 * The person behind a ref: a handle is decrypted and verified; anything else
 * is a raw id (the contract before handles, still accepted). Null for a handle
 * that does not verify — malformed, truncated, tampered or from another key —
 * and for one from a room that is not an event's, which names nobody outside
 * its own room (see the note at the top).
 */
export function resolveUserRef(ref: string): { userId: string; eventId: string | null } | null {
  if (!isRoomHandle(ref)) return { userId: ref, eventId: null }
  const opened = openHandle(ref)
  if (!opened || typeof opened.scope !== "string") return null
  return { userId: opened.userId, eventId: opened.scope }
}

/**
 * The account id a route should act on, for a ref a client sent.
 *
 * A handle that does not verify comes back **unchanged**, not null. No account
 * id begins `rh_` (they are cuids), so every lookup downstream misses exactly
 * as it does for an id nobody has — and the route answers a forged handle with
 * the same status, the same body and the same order of checks as an unknown
 * id, without each route restating what "unknown" looks like at its position.
 */
export function userIdFromRef(ref: string): string {
  return resolveUserRef(ref)?.userId ?? ref
}

/**
 * Who a room-only action — a like, a wave — may name: somebody this room
 * showed the caller, by the handle it showed, or the caller by their own id
 * (the roster lists you as yourself, and "you cannot wave at yourself" is the
 * honest answer to that). Null for anything else — a raw id, another room's
 * handle of any kind, a forged one — which the route answers as an unknown
 * person. An event route passes its event id as the scope.
 *
 * Stricter than `userIdFromRef` because these two answer from the room's live
 * state. A raw id there asked "is this account checked in here right now", and
 * the wave window, keyed on the real pair, turned one raw-id wave into a
 * finder: wave at your friend's real id, then at each handle on the roster,
 * and the one refused as too soon was them. Every legitimate caller holds a
 * handle for these, because the roster and the deck are all that name anyone.
 */
export function roomMemberFromRef(scope: RoomScope, ref: string, viewerId: string): string | null {
  if (ref === viewerId) return viewerId
  const opened = isRoomHandle(ref) ? openHandle(ref) : null
  if (!opened || !sameScope(opened.scope, scope)) return null
  return opened.userId
}

/**
 * One person's id as `viewerId` should see it in `scope`'s room: their own
 * stays real, everyone else's is the handle.
 */
export function idForViewer(viewerId: string, scope: RoomScope, userId: string): string {
  return userId === viewerId ? userId : roomHandle(scope, userId)
}

/**
 * The block list's id for somebody you blocked.
 *
 * `GET /users/blocked` returned their account id, so blocking a board author
 * by their post — or a room member by their handle — handed over the stable id
 * that the pseudonym exists to withhold, one that follows them to every event.
 * The list now returns the block row's own id, prefixed, in the same field;
 * `DELETE /users/:userId/block` takes it back, and only for the caller's own
 * block. It names nothing outside that one row and dies with it.
 */
const BLOCK_REF = "bk_"

export const blockRef = (blockId: string): string => `${BLOCK_REF}${blockId}`

/** The block row id inside a ref from the list, or null if it is not one. */
export function blockIdFromRef(ref: string): string | null {
  return ref.startsWith(BLOCK_REF) ? ref.slice(BLOCK_REF.length) : null
}
