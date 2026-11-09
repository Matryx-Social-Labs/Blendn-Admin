import { readdirSync, statSync } from "fs"
import { join, relative, sep } from "path"
import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

import { signAccessToken } from "@/lib/mobile-auth"

import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, onboard, putInRoom } from "./helpers"

/**
 * Every mobile GET, read by somebody an unrevealed match has not revealed to,
 * holds none of that person's identity (SCRUM-752).
 *
 * The ticket was one route handing out a raw id beside a pseudonym, and a
 * second route turning that id into a name. The fix that followed was route
 * by route: inbox, detail, thread, sockets, friends, profiles. This is the
 * sweep that catches the NEXT route, which is the one nobody thinks of: it
 * walks `app/api/mobile`, calls every GET it can fill the params of with what
 * the viewer was actually handed, and searches each answer for the other
 * person's account id, real name, email and photo.
 *
 * The world is built through the real routes: both check in, set preferences,
 * like each other off the deck (so the match, its conversation and its
 * pseudonyms are written by the product), the viewer reveals and the other
 * does not, and the other then messages, chats in the room, posts on the
 * board and waves. Then the viewer reads everything.
 */

const ROOT = join(__dirname, "..", "..")
const MOBILE = join(ROOT, "app", "api", "mobile")

type Handler = (req: NextRequest, ctx: { params: Promise<never> }) => Promise<Response>
interface Person {
  id: string
  token: string
}

const users: string[] = []
const viewerAnswers: { what: string; text: string }[] = []
const events: string[] = []

const SECRET_NAME = "Benedict Quixotewright"
const SECRET_PHOTO = "https://cdn.itest.invalid/benedict-quixotewright.jpg"
const SECRET_BLUR = "https://cdn.itest.invalid/benedict-quixotewright.blur.jpg"

async function person(label: string, name: string, photo: string, blur: string): Promise<Person> {
  const id = await makeUser(label)
  users.push(id)
  await onboard(id)
  await db.profiles.update({
    where: { id },
    data: { name, bio: `bio of ${name}`, photos: [photo], blur_photo: blur, date_of_birth: new Date("1995-01-01") },
  })
  await db.user.update({ where: { id }, data: { name, image: photo } })
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
}

async function call(handler: Handler, path: string, as: Person, opts: { method?: string; body?: unknown; params?: Record<string, string> } = {}) {
  const res = await handler(
    new NextRequest(`http://localhost${path}`, {
      method: opts.method ?? "GET",
      headers: { authorization: `Bearer ${as.token}`, "content-type": "application/json" },
      ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
    }),
    { params: Promise.resolve(opts.params ?? {}) as Promise<never> }
  )
  const text = await res.text()
  // Everything the viewer is answered, writes included: a like, a reveal or a reply goes back to them too.
  if (as === viewer) viewerAnswers.push({ what: `${opts.method ?? "GET"} ${path}`, text })
  return { status: res.status, text, body: text ? (JSON.parse(text) as any) : null } // eslint-disable-line @typescript-eslint/no-explicit-any
}

const route = (rel: string) => require(join(MOBILE, rel, "route.ts")) as Record<string, Handler> // eslint-disable-line @typescript-eslint/no-require-imports

async function ok(p: ReturnType<typeof call>, what: string) {
  const r = await p
  if (r.status >= 300) throw new Error(`${what}: ${r.status} ${r.text}`)
  return r.body
}

/** Every `route.ts` under app/api/mobile exporting GET, as its path relative to MOBILE. */
function getRoutes(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name === "route.ts") out.push(relative(MOBILE, dir).split(sep).join("/"))
    }
  }
  walk(MOBILE)
  return out.filter((rel) => typeof route(rel).GET === "function").sort()
}

const paramsOf = (rel: string) => [...rel.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1])

const emits: { rooms: string[]; event: string; payload: unknown }[] = []
const shared = globalThis as { __blendnSocketIo?: unknown }
/**
 * Room-wide emits address rooms; per-viewer copies go socket by socket through `fetchSockets()`. Both people hold
 * one socket in every room, so a per-viewer copy is recorded as sent to `user:<them>`.
 */
const socketsInRoom = () =>
  [viewer, other].map((p) => ({
    id: `sock-${p.id}`,
    data: { userId: p.id },
    leave: () => undefined,
    join: () => undefined,
    emit: (event: string, payload: unknown) => void emits.push({ rooms: [`user:${p.id}`], event, payload }),
  }))
const fakeIo = () => {
  type Chain = { to: (r: string | string[]) => Chain; in: (r: string | string[]) => Chain; except: (r: unknown) => Chain; emit: (event: string, payload: unknown) => void; fetchSockets: () => Promise<unknown[]>; socketsLeave: () => void; socketsJoin: () => void }
  const chain = (rooms: string[]): Chain => ({
    to: (r) => chain([...rooms, ...[r].flat()]),
    in: (r) => chain([...rooms, ...[r].flat()]),
    except: () => chain(rooms),
    emit: (event, payload) => void emits.push({ rooms, event, payload }),
    fetchSockets: async () => socketsInRoom(),
    socketsLeave: () => undefined,
    socketsJoin: () => undefined,
  })
  return { ...chain([]), to: (r: string | string[]) => chain([r].flat()), in: (r: string | string[]) => chain([r].flat()) }
}

let viewer: Person
let other: Person
let eventId: string
let conversationId: string
const refs: Record<string, string[]> = {}

/** What `other` must never be to `viewer` while unrevealed: their id, name, email, photo and blur. */
const secretsOf = (p: Person) => [p.id, SECRET_NAME, "Quixotewright", `${p.id}@itest.invalid`, SECRET_PHOTO, SECRET_BLUR]
const leaksIn = (text: string) => secretsOf(other).filter((s) => text.includes(s))

beforeAll(async () => {
  shared.__blendnSocketIo = fakeIo()
  viewer = await person("uis-viewer", "Vee Viewer", "https://cdn.itest.invalid/vee.jpg", "https://cdn.itest.invalid/vee.blur.jpg")
  other = await person("uis-other", SECRET_NAME, SECRET_PHOTO, SECRET_BLUR)

  const host = await makeUser("uis-host", "organizer")
  users.push(host)
  eventId = await makeEvent(host)
  events.push(eventId)
  const occurrenceId = await occurrenceOf(eventId)
  for (const p of [viewer, other]) {
    await db.event_rsvps.create({ data: { event_id: eventId, user_id: p.id, status: "going" } })
    await putInRoom({ eventId, occurrenceId, userId: p.id })
  }

  const prefs = route("events/[eventId]/matches/preferences")
  for (const p of [viewer, other]) {
    await ok(call(prefs.PUT, `/api/mobile/events/${eventId}/matches/preferences`, p, { method: "PUT", body: { intent: ["friendship"], revealed: false }, params: { eventId } }), "preferences")
  }

  const deck = route("events/[eventId]/matches")
  const likes = route("events/[eventId]/matches/likes")
  const handleIn = async (as: Person, of: Person) => {
    const body = await ok(call(deck.GET, `/api/mobile/events/${eventId}/matches`, as, { params: { eventId } }), "deck")
    const all = (body.data?.matches ?? []) as { userId: string; name?: string }[]
    const mine = all.filter((m) => m.userId !== as.id)
    if (mine.length !== 1) throw new Error(`deck for ${as.id} expected one person, got ${JSON.stringify(all)} (of ${of.id})`)
    return mine[0].userId
  }
  const roomHandle = await handleIn(viewer, other)
  refs.room = [roomHandle]
  const viewerHandle = await handleIn(other, viewer)
  await ok(call(likes.POST, `/api/mobile/events/${eventId}/matches/likes`, viewer, { method: "POST", body: { userId: roomHandle }, params: { eventId } }), "like 1")
  const liked = await ok(call(likes.POST, `/api/mobile/events/${eventId}/matches/likes`, other, { method: "POST", body: { userId: viewerHandle }, params: { eventId } }), "like 2")
  conversationId = liked.data?.conversationId
  if (!liked.data?.mutual || !conversationId) throw new Error(`expected a mutual like, got ${JSON.stringify(liked)}`)

  // The viewer reveals to the other; the other does not reveal back.
  await ok(call(route("conversations/[conversationId]/reveal").POST, `/api/mobile/conversations/${conversationId}/reveal`, viewer, { method: "POST", body: {}, params: { conversationId } }), "reveal")

  // The other talks: a DM, the room chat, a board post, a wave.
  await ok(call(route("conversations/[conversationId]/messages").POST, `/api/mobile/conversations/${conversationId}/messages`, other, { method: "POST", body: { text: "hey from heron" }, params: { conversationId } }), "dm")
  await ok(call(route("conversations/[conversationId]/messages").POST, `/api/mobile/conversations/${conversationId}/messages`, viewer, { method: "POST", body: { text: "hi heron" }, params: { conversationId } }), "dm reply")
  await ok(call(route("events/[eventId]/chat").POST, `/api/mobile/events/${eventId}/chat`, other, { method: "POST", body: { content: "hello room" }, params: { eventId } }), "room chat")
  // The viewer opens the room, which is what makes them a member of its chat group.
  await ok(call(route("events/[eventId]/chat").GET, `/api/mobile/events/${eventId}/chat`, viewer, { params: { eventId } }), "open room")
  // The board is read-only once doors open, so the post is one they left in the Lobby before.
  const post = await db.board_posts.create({ data: { event_id: eventId, author_id: other.id, kind: "chat", body: "anyone for a drink" } })
  refs.postId = [post.id]
  await ok(call(route("events/[eventId]/waves").POST, `/api/mobile/events/${eventId}/waves`, other, { method: "POST", body: { toUserId: viewerHandle }, params: { eventId } }), "wave")

  // What the viewer was handed for the other in the DM.
  const inbox = await ok(call(route("conversations").GET, "/api/mobile/conversations", viewer), "inbox")
  const row = (inbox.data?.conversations ?? inbox.data ?? []).find?.((c: { id: string }) => c.id === conversationId)
  if (!row) throw new Error(`inbox has no row for the match: ${JSON.stringify(inbox)}`)
  refs.dm = [row.otherUser?.id].filter(Boolean)

  const group = await db.chat_groups.findFirst({ where: { event_id: eventId }, select: { id: true } })
  refs.chatGroupId = group ? [group.id] : []
}, 60_000)

afterAll(async () => {
  shared.__blendnSocketIo = undefined
  await db.event_likes.deleteMany({ where: { OR: [{ liker_id: { in: users } }, { liked_id: { in: users } }] } })
  await db.private_messages.deleteMany({ where: { conversation: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] } } })
  await db.private_conversations.deleteMany({ where: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] } })
  await db.board_posts.deleteMany({ where: { event_id: { in: events } } }).catch(() => undefined)
  await cleanup(users, events)
  await closeDb()
})

/** Each GET with its params filled every way the viewer can fill them; routes whose params the viewer holds nothing for are skipped. */
function calls(): { rel: string; params: Record<string, string> }[] {
  const values: Record<string, string[]> = {
    eventId: [eventId],
    conversationId: [conversationId],
    chatGroupId: refs.chatGroupId,
    postId: refs.postId,
    userId: [...refs.room, ...refs.dm],
  }
  const out: { rel: string; params: Record<string, string> }[] = []
  for (const rel of getRoutes()) {
    const names = paramsOf(rel)
    if (names.some((n) => !values[n]?.length)) continue
    let combos: Record<string, string>[] = [{}]
    for (const n of names) combos = combos.flatMap((c) => values[n].map((v) => ({ ...c, [n]: v })))
    for (const params of combos) out.push({ rel, params })
  }
  return out
}

describe("an unrevealed match is nobody, on every mobile GET and every socket emit", () => {
  it("built the world the product would: a pseudonymous DM, a handle, never the raw id", () => {
    expect(refs.dm).toHaveLength(1)
    expect(refs.dm[0]).not.toBe(other.id)
    expect(refs.room[0]).not.toBe(other.id)
    expect(refs.postId).toHaveLength(1)
  })

  it("holds none of their identity in any GET the viewer can make", async () => {
    const found: string[] = []
    const tried: string[] = []
    for (const { rel, params } of calls()) {
      const path = `/api/mobile/${rel.replace(/\[([^\]]+)\]/g, (_, n: string) => params[n])}`
      const r = await call(route(rel).GET, path, viewer, { params })
      tried.push(`${r.status} ${rel} ${JSON.stringify(params)}`)
      const leaked = leaksIn(r.text)
      if (leaked.length) found.push(`${rel} ${JSON.stringify(params)} -> ${r.status} leaks ${leaked.map((s) => (s === other.id ? "<raw id>" : s)).join(", ")}`)
    }
    // A sweep that called nothing proves nothing: the routes the ticket is about must be in it, and answering.
    for (const must of ["conversations", "conversations/[conversationId]", "conversations/[conversationId]/messages", "events/[eventId]/matches", "profiles/[userId]"]) {
      expect(tried.some((t) => t.split(" ")[1] === must && t.startsWith("2"))).toBe(true)
    }
    expect(tried.length).toBeGreaterThan(40)
    expect(found).toEqual([])
  }, 120_000)

  it("answered none of the viewer's own writes with it: the like, the reveal, the reply", () => {
    const writes = viewerAnswers.filter((a) => !a.what.startsWith("GET"))
    expect(writes.length).toBeGreaterThanOrEqual(4)
    expect(viewerAnswers.filter((a) => leaksIn(a.text).length).map((a) => a.what)).toEqual([])
  })

  it("sent none of it on a socket emit that reaches the viewer", () => {
    const toViewer = emits.filter((e) => !(e.rooms.length > 0 && e.rooms.every((r) => r === `user:${other.id}`)))
    expect(toViewer.length).toBeGreaterThan(0)
    const found = toViewer
      .map((e) => ({ e, leaked: leaksIn(JSON.stringify(e.payload)) }))
      .filter((x) => x.leaked.length)
      .map((x) => `${x.e.event} to ${x.e.rooms.join(",")} leaks ${x.leaked.map((s) => (s === other.id ? "<raw id>" : s)).join(", ")}`)
    expect(found).toEqual([])
  })

  it("does find them once they reveal, so the sweep can see a leak at all", async () => {
    await ok(call(route("conversations/[conversationId]/reveal").POST, `/api/mobile/conversations/${conversationId}/reveal`, other, { method: "POST", body: {}, params: { conversationId } }), "reveal back")
    const r = await call(route("conversations").GET, "/api/mobile/conversations", viewer)
    expect(leaksIn(r.text)).toEqual(expect.arrayContaining([other.id, SECRET_NAME]))
  })
})
