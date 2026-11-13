import { readdirSync, statSync } from "fs"
import { join, relative, sep } from "path"
import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

import { signAccessToken } from "@/lib/mobile-auth"
import { flushProductEvents } from "@/lib/product-events"

import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, onboard, putInRoom, testId } from "./helpers"

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
 * board and waves. Then the viewer reads everything — the recorded wave's
 * room list and Banter row included (SCRUM-1042), which a host must never
 * read a wave from.
 *
 * The other also answers tonight's question (Flow 5 · P-A, lib/tonight.ts):
 * the answer reaches the viewer beside the pseudonym, so the sweep must see
 * it arrive (or it proves nothing about the new fields) and still find no
 * identity; and a host who runs the room, checked in, must find it nowhere.
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
/** The other's answer to tonight's question: room words, readable by the room, never by its host. */
const TONIGHT_ANSWER = "Restoring a 1962 Vespa in my garage"
/** The other's crew: a stranger in the room may see its card, a host never sees it at all. */
const CREW_NAME = "Quixote Crew"
/** Why the other is here (the work lens): the same readers as the answer, and a host gets it nowhere. As it appears in a body. */
const WORK_INTENT = `"workIntent":"build"`

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
let hostId: string
/** A night before this one that both came to, the other a pseudonym there: "You've both been to" must never list it. */
let pastId: string
const lensSlugs: string[] = []
const categoryIds: string[] = []
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
  hostId = host
  eventId = await makeEvent(host)
  events.push(eventId)
  // A category whose lens asks a question, so the other can answer it.
  const slug = testId("uis-work")
  const category = await db.categories.create({ data: { name: slug, slug } })
  categoryIds.push(category.id)
  await db.category_lenses.create({ data: { category_slug: slug, lens_key: "work" } })
  lensSlugs.push(slug)
  await db.event_categories.create({ data: { event_id: eventId, category_id: category.id, primary: true } })
  const occurrenceId = await occurrenceOf(eventId)
  for (const p of [viewer, other]) {
    await db.event_rsvps.create({ data: { event_id: eventId, user_id: p.id, status: "going" } })
    await putInRoom({ eventId, occurrenceId, userId: p.id })
  }

  const prefs = route("events/[eventId]/matches/preferences")
  for (const p of [viewer, other]) {
    await ok(call(prefs.PUT, `/api/mobile/events/${eventId}/matches/preferences`, p, { method: "PUT", body: { intent: ["friendship"], revealed: false }, params: { eventId } }), "preferences")
  }
  await ok(call(prefs.PUT, `/api/mobile/events/${eventId}/matches/preferences`, other, { method: "PUT", body: { tonightAnswer: TONIGHT_ANSWER, workIntent: "build" }, params: { eventId } }), "tonight's answer")

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

  // The other came in with their crew, and so did its other member (crews S1–S2): the viewer, a
  // stranger open to crews, may see its card — counts, never who — and its strip is the members' only.
  const mate = await person("uis-mate", "Mabel Crewmate", "https://cdn.itest.invalid/mabel.jpg", "https://cdn.itest.invalid/mabel.blur.jpg")
  const [user1_id, user2_id] = [other.id, mate.id].sort()
  await db.friendships.create({ data: { user1_id, user2_id } })
  const made = await ok(call(route("crews").POST, "/api/mobile/crews", other, { method: "POST", body: { name: CREW_NAME, inviteUserIds: [mate.id], revealConsent: true } }), "crew")
  const crewId = made.data.crewId as string
  await ok(call(route("crews/[crewId]/join").POST, `/api/mobile/crews/${crewId}/join`, mate, { method: "POST", body: { revealConsent: true }, params: { crewId } }), "crew join")
  await db.crews.update({ where: { id: crewId }, data: { open_to_solo: true } })
  await putInRoom({ eventId, occurrenceId, userId: mate.id })
  for (const p of [other, mate]) {
    await ok(call(route("crews/[crewId]/here").POST, `/api/mobile/crews/${crewId}/here`, p, { method: "POST", body: { eventId }, params: { crewId } }), "crew here")
  }
  await ok(call(prefs.PUT, `/api/mobile/events/${eventId}/matches/preferences`, viewer, { method: "PUT", body: { openToCrews: true }, params: { eventId } }), "open to crews")

  // What the viewer was handed for the other in the DM.
  const inbox = await ok(call(route("conversations").GET, "/api/mobile/conversations", viewer), "inbox")
  const row = (inbox.data?.conversations ?? inbox.data ?? []).find?.((c: { id: string }) => c.id === conversationId)
  if (!row) throw new Error(`inbox has no row for the match: ${JSON.stringify(inbox)}`)
  refs.dm = [row.otherUser?.id].filter(Boolean)

  const group = await db.chat_groups.findFirst({ where: { event_id: eventId }, select: { id: true } })
  refs.chatGroupId = group ? [group.id] : []

  pastId = await makeEvent(host)
  events.push(pastId)
  const lastWeek = { start_time: new Date(Date.now() - 7 * 86_400_000), end_time: new Date(Date.now() - 7 * 86_400_000 + 7_200_000) }
  await db.events.update({ where: { id: pastId }, data: lastWeek })
  await db.event_occurrences.updateMany({ where: { event_id: pastId }, data: lastWeek })
  const pastOccurrence = await occurrenceOf(pastId)
  const pastRoom = await db.chat_groups.create({ data: { event_id: pastId, name: "room" }, select: { id: true } })
  for (const p of [viewer, other]) {
    await db.event_check_ins.create({
      data: { event_id: pastId, occurrence_id: pastOccurrence, user_id: p.id, kind: "attendee", status: "checked_out", check_in_time: lastWeek.start_time, check_out_time: lastWeek.end_time },
    })
    await db.chat_group_members.create({ data: { chat_group_id: pastRoom.id, user_id: p.id, anonymous_name: testId("Zq Last Week") } })
  }
}, 60_000)

afterAll(async () => {
  shared.__blendnSocketIo = undefined
  // The routes record product events in a batch; write it before the pool closes, not after the suite has gone.
  await flushProductEvents()
  await db.event_likes.deleteMany({ where: { OR: [{ liker_id: { in: users } }, { liked_id: { in: users } }] } })
  await db.event_waves.deleteMany({ where: { OR: [{ from_id: { in: users } }, { to_id: { in: users } }] } })
  await db.private_messages.deleteMany({ where: { conversation: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] } } })
  await db.private_conversations.deleteMany({ where: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] } })
  await db.board_posts.deleteMany({ where: { event_id: { in: events } } }).catch(() => undefined)
  const crews = { crew: { created_by: { in: users } } }
  await db.chat_messages.deleteMany({ where: { chat_group: crews } })
  await db.chat_group_members.deleteMany({ where: { chat_group: crews } })
  await db.chat_groups.deleteMany({ where: crews })
  await db.crew_invites.deleteMany({ where: crews })
  await db.crew_members.deleteMany({ where: crews })
  await db.crews.deleteMany({ where: { created_by: { in: users } } })
  await db.notifications.deleteMany({ where: { user_id: { in: users } } })
  await db.friendships.deleteMany({ where: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] } })
  await cleanup(users, events)
  await db.category_lenses.deleteMany({ where: { category_slug: { in: lensSlugs } } })
  await db.categories.deleteMany({ where: { id: { in: categoryIds } } })
  await db.organisation_members.deleteMany({ where: { user_id: hostId } })
  await db.organisations.deleteMany({ where: { display_name: { startsWith: "itest_uis-org" } } })
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
    for (const must of ["conversations", "conversations/[conversationId]", "conversations/[conversationId]/messages", "events/[eventId]/matches", "profiles/[userId]", "users/[userId]/shared-events"]) {
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

  it("reached the viewer with the other's answer, on the deck and the person sheet, beside no identity", async () => {
    const deck = await call(route("events/[eventId]/matches").GET, `/api/mobile/events/${eventId}/matches`, viewer, { params: { eventId } })
    expect(deck.body.data.matches.find((m: { userId: string }) => m.userId === refs.room[0])?.tonightAnswer).toBe(TONIGHT_ANSWER)
    const sheet = await call(route("users/[userId]").GET, `/api/mobile/users/${refs.room[0]}`, viewer, { params: { userId: refs.room[0] } })
    expect(sheet.body.data.tonight?.answer).toBe(TONIGHT_ANSWER)
    // Its why-I'm-here too: the control for the host search below, which looks for this fragment.
    expect(deck.text).toContain(WORK_INTENT)
    expect(sheet.text).toContain(WORK_INTENT)
    expect(leaksIn(deck.text)).toEqual([])
    expect(leaksIn(sheet.text)).toEqual([])
  })

  it("reached the viewer with the other's crew as a card — counts, never who (crews S2)", async () => {
    const seen = await call(route("events/[eventId]/crews").GET, `/api/mobile/events/${eventId}/crews`, viewer, { params: { eventId } })
    expect(seen.body.data.crews.map((c: { name: string; presentCount: number }) => [c.name, c.presentCount])).toEqual([[CREW_NAME, 2]])
    expect(seen.text).not.toContain('"here"')
  })

  it("reached the viewer with the other's recorded wave, on the room's list, Banter's row and the deck, by handle beside no identity (SCRUM-1042)", async () => {
    const list = await call(route("events/[eventId]/waves").GET, `/api/mobile/events/${eventId}/waves`, viewer, { params: { eventId } })
    expect(list.body.data.waves.map((w: { userId: string }) => w.userId)).toEqual([refs.room[0]])
    // Answered already: the viewer's like was the answer (an old like is a hidden wave), so Banter has nothing waiting.
    expect(list.body.data.waves[0].wavedBack).toBe(true)
    const banter = await call(route("waves").GET, "/api/mobile/waves", viewer)
    expect(banter.body.data.rooms).toEqual([])
    const deck = await call(route("events/[eventId]/matches").GET, `/api/mobile/events/${eventId}/matches`, viewer, { params: { eventId } })
    expect(deck.body.data.matches.find((m: { userId: string }) => m.userId === refs.room[0])?.wavedAtYou).toBe(true)
    for (const r of [list, banter, deck]) expect(leaksIn(r.text)).toEqual([])
  })

  it("hands the answer and the why-I'm-here to no GET a host who runs the room can make, checked in or not", async () => {
    const org = await db.organisations.create({ data: { display_name: testId("uis-org") } })
    await db.organisation_members.create({ data: { org_id: org.id, user_id: hostId, role: "staff" } })
    await db.events.update({ where: { id: eventId }, data: { organizer_org_id: org.id } })
    await putInRoom({ eventId, occurrenceId: await occurrenceOf(eventId), userId: hostId })
    const host: Person = { id: hostId, token: signAccessToken(hostId, `${hostId}@itest.invalid`) }

    const found: string[] = []
    const answered = new Set<string>()
    for (const { rel, params } of calls()) {
      const path = `/api/mobile/${rel.replace(/\[([^\]]+)\]/g, (_, n: string) => params[n])}`
      const r = await call(route(rel).GET, path, host, { params })
      if (r.status < 300) answered.add(rel)
      // Nor any wave, wave count or wave-derived field (SCRUM-1042: hosts never wave or get waved at).
      const waveDerived = ['"wavedAt"', '"waiting"', '"wavedAtYou":true', '"youWaved":true'].some((t) => r.text.includes(t))
      // Nor any crew: hosts get counts in their insights, never a crew's name or who is in it (crews 6A).
      const crewDerived = r.text.includes(CREW_NAME) || r.text.includes('"here":[{')
      if (r.text.includes(TONIGHT_ANSWER) || r.text.includes(WORK_INTENT) || waveDerived || crewDerived) found.push(`${rel} ${JSON.stringify(params)} -> ${r.status}`)
    }
    // The deck and the person sheet answered the host: withheld there, not merely refused.
    expect([...answered]).toEqual(expect.arrayContaining(["events/[eventId]/matches", "users/[userId]"]))
    expect(found).toEqual([])
  }, 120_000)

  it("lists no past night they were a pseudonym at, by any ref the viewer holds (SCRUM-1042)", async () => {
    for (const ref of [...refs.room, ...refs.dm]) {
      const r = await call(route("users/[userId]/shared-events").GET, `/api/mobile/users/${ref}/shared-events`, viewer, { params: { userId: ref } })
      expect(r.status).toBe(200)
      expect(r.body.data.events).toEqual([])
      expect(r.text).not.toContain(pastId)
    }
  })

  it("does find them once they reveal, so the sweep can see a leak at all", async () => {
    await ok(call(route("conversations/[conversationId]/reveal").POST, `/api/mobile/conversations/${conversationId}/reveal`, other, { method: "POST", body: {}, params: { conversationId } }), "reveal back")
    const r = await call(route("conversations").GET, "/api/mobile/conversations", viewer)
    expect(leaksIn(r.text)).toEqual(expect.arrayContaining([other.id, SECRET_NAME]))
    // And once they had named themselves at last week's night, it is a night you have both been to.
    await db.event_match_preferences.create({ data: { event_id: pastId, user_id: other.id, revealed: true } })
    // By the id the inbox hands over once they have revealed (asserted just above): the DM's handle stays its room's.
    const ref = other.id
    const shared = await call(route("users/[userId]/shared-events").GET, `/api/mobile/users/${ref}/shared-events`, viewer, { params: { userId: ref } })
    expect(shared.body.data.events.map((e: { id: string }) => e.id)).toEqual([pastId])
  })
})
