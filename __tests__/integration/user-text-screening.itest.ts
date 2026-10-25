import { NextRequest } from "next/server"

/*
 * Text strangers read is screened on write (App Store 1.2): a display name, a
 * bio, the occupation and education beside it, a crew's name and bio, and the
 * first message of a message request. A slur in any of them is a 400
 * `VALIDATION_FAILED` / `TEXT_NOT_ALLOWED`, nothing is stored, and the refusal
 * is an audit row. Ordinary text goes through. Real routes, real rows.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"
import { conversationPair } from "@/lib/conversations"
import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, onboard, putInRoom, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const profileRoute = require("@/app/api/mobile/profiles/[userId]/route") as typeof import("@/app/api/mobile/profiles/[userId]/route")
const signupRoute = require("@/app/api/mobile/auth/signup/route") as typeof import("@/app/api/mobile/auth/signup/route")
const requestsRoute = require("@/app/api/mobile/message-requests/route") as typeof import("@/app/api/mobile/message-requests/route")
const crewsRoute = require("@/app/api/mobile/crews/route") as typeof import("@/app/api/mobile/crews/route")
const crewRoute = require("@/app/api/mobile/crews/[crewId]/route") as typeof import("@/app/api/mobile/crews/[crewId]/route")
/* eslint-enable @typescript-eslint/no-require-imports */

type Handler = (req: NextRequest, ctx: { params: Promise<never> }) => Promise<Response>
interface Person {
  id: string
  token: string
}

const SLUR = "you retard"
const users: string[] = []
const events: string[] = []
const signupEmails: string[] = []

afterAll(async () => {
  const signedUp = await db.user.findMany({ where: { email: { in: signupEmails } }, select: { id: true } })
  users.push(...signedUp.map((u) => u.id))
  await db.audit_logs.deleteMany({ where: { OR: [{ resource_id: { in: users } }, { action: "moderation.text_refused", user_id: null }] } })
  await db.message_requests.deleteMany({ where: { sender_id: { in: users } } })
  await db.crew_invites.deleteMany({ where: { crew: { members: { some: { user_id: { in: users } } } } } })
  const crews = await db.crew_members.findMany({ where: { user_id: { in: users } }, select: { crew_id: true } })
  await db.chat_groups.deleteMany({ where: { crew_id: { in: crews.map((c) => c.crew_id) } } })
  await db.crew_members.deleteMany({ where: { user_id: { in: users } } })
  await db.crews.deleteMany({ where: { id: { in: crews.map((c) => c.crew_id) } } })
  await db.friendships.deleteMany({ where: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] } })
  await cleanup(users, events)
  await closeDb()
})

async function person(label: string): Promise<Person> {
  const id = await makeUser(testId(label))
  users.push(id)
  await onboard(id)
  await db.profiles.update({ where: { id }, data: { name: `Asha ${label}`, age: 27 } })
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
}

async function call(handler: unknown, path: string, as: Person | null, method: string, body: unknown, params: Record<string, string> = {}) {
  const res = await (handler as Handler)(
    new NextRequest(`http://localhost${path}`, {
      method,
      headers: { "content-type": "application/json", ...(as && { authorization: `Bearer ${as.token}` }) },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve(params) as Promise<never> }
  )
  return { status: res.status, body: await res.json() }
}

function expectRefused(res: { status: number; body: Record<string, unknown> }, field: string) {
  expect(res.status).toBe(400)
  expect(res.body).toMatchObject({ errorCode: "VALIDATION_FAILED", reasonCode: "TEXT_NOT_ALLOWED", field })
}

/** `auditLog` is fire-and-forget: wait for the refusal's row. */
async function refusalAudit(userId: string | null, field: string) {
  for (let i = 0; i < 50; i++) {
    const rows = await db.audit_logs.findMany({ where: { action: "moderation.text_refused", user_id: userId } })
    const row = rows.find((r) => (r.details as { field?: string }).field === field)
    if (row) return row.details as Record<string, unknown>
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`no moderation.text_refused row for ${field}`)
}

describe("profile", () => {
  const put = (p: Person, body: Record<string, unknown>) =>
    call(profileRoute.PUT, `/api/mobile/profiles/${p.id}`, p, "PUT", body, { userId: p.id })

  it.each(["name", "bio", "occupation", "education"])("refuses a slur in %s, stores nothing, and audits it", async (field) => {
    const p = await person(`pt-${field}`)
    const before = await db.profiles.findUniqueOrThrow({ where: { id: p.id } })

    expectRefused(await put(p, { [field]: SLUR }), field)

    const after = await db.profiles.findUniqueOrThrow({ where: { id: p.id } })
    expect(after[field as "name"]).toBe(before[field as "name"])
    expect(await refusalAudit(p.id, field)).toMatchObject({ surface: "profile", field, source: "keyword", matched: ["retard"] })
  })

  it("refuses link spam in a bio", async () => {
    const p = await person("pt-links")
    expectRefused(await put(p, { bio: "https://a.test https://b.test https://c.test" }), "bio")
    expect(await refusalAudit(p.id, "bio")).toMatchObject({ source: "spam" })
  })

  it("saves ordinary text", async () => {
    const p = await person("pt-ok")
    const res = await put(p, { name: "Asha Rao", bio: "Here for the music.", occupation: "Designer", education: "NID" })
    expect(res.status).toBe(200)
    expect(await db.profiles.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({
      name: "Asha Rao",
      bio: "Here for the music.",
      occupation: "Designer",
      education: "NID",
    })
  })
})

describe("sign-up", () => {
  const signup = (name: string) => {
    const email = `${testId("su")}@itest.invalid`
    signupEmails.push(email)
    return call(signupRoute.POST, "/api/mobile/auth/signup", null, "POST", { email, password: "Correct-horse-battery-9", name, age: 27 }).then(
      (res) => ({ ...res, email })
    )
  }

  it("refuses a slur as the name and creates no account", async () => {
    const res = await signup(SLUR)
    expectRefused(res, "name")
    expect(await db.user.count({ where: { email: res.email } })).toBe(0)
    expect(await refusalAudit(null, "name")).toMatchObject({ surface: "profile" })
  })

  it("creates the account with an ordinary name", async () => {
    const res = await signup("Asha Rao")
    expect(res.status).toBe(201)
  })
})

describe("message request", () => {
  let a: Person
  let b: Person

  beforeAll(async () => {
    const host = await makeUser(testId("mr-host"), "organizer")
    users.push(host)
    const eventId = await makeEvent(host)
    events.push(eventId)
    ;[a, b] = await Promise.all([person("mr-a"), person("mr-b")])
    const occ = await occurrenceOf(eventId)
    await putInRoom({ eventId, occurrenceId: occ, userId: a.id })
    await putInRoom({ eventId, occurrenceId: occ, userId: b.id })
  })

  const ask = (from: Person, to: Person, message: string) =>
    call(requestsRoute.POST, "/api/mobile/message-requests", from, "POST", { recipientId: to.id, message })

  it("refuses a slur as the first message and sends nothing", async () => {
    expectRefused(await ask(a, b, SLUR), "message")
    expect(await db.message_requests.count({ where: { sender_id: a.id } })).toBe(0)
    expect(await refusalAudit(a.id, "message")).toMatchObject({ surface: "message_request" })
  })

  it("sends an ordinary first message", async () => {
    expect((await ask(b, a, "coffee after the set?")).status).toBe(201)
    expect(await db.message_requests.count({ where: { sender_id: b.id } })).toBe(1)
  })
})

describe("crew", () => {
  async function owner() {
    const [o, friend] = await Promise.all([person("cr-o"), person("cr-f")])
    const [user1_id, user2_id] = conversationPair(o.id, friend.id)
    await db.friendships.create({ data: { user1_id, user2_id } })
    return { o, friend }
  }
  const create = (o: Person, friend: Person, body: Record<string, unknown>) =>
    call(crewsRoute.POST, "/api/mobile/crews", o, "POST", { revealConsent: true, inviteUserIds: [friend.id], ...body })

  it.each(["name", "bio"])("refuses a slur in the crew's %s on create and on edit, and audits it", async (field) => {
    const { o, friend } = await owner()
    const refused = await create(o, friend, { name: "Saturday Lot", [field]: SLUR })
    expectRefused(refused, field)
    expect(await db.crew_members.count({ where: { user_id: o.id } })).toBe(0)
    expect(await refusalAudit(o.id, field)).toMatchObject({ surface: "crew", source: "keyword" })

    const made = await create(o, friend, { name: "Saturday Lot" })
    expect(made.status).toBe(201)
    const crewId = made.body.data.crewId as string
    expectRefused(await call(crewRoute.PATCH, `/api/mobile/crews/${crewId}`, o, "PATCH", { [field]: SLUR }, { crewId }), field)
    expect(await db.crews.findUniqueOrThrow({ where: { id: crewId }, select: { name: true } })).toEqual({ name: "Saturday Lot" })
  })

  it("keeps contact details a plain refusal, without TEXT_NOT_ALLOWED", async () => {
    const { o, friend } = await owner()
    const res = await create(o, friend, { name: "Saturday Lot", bio: "dm us @thelot" })
    expect(res.status).toBe(400)
    expect(res.body.errorCode).toBe("VALIDATION_FAILED")
    expect(res.body.reasonCode).toBeUndefined()
  })

  it("makes and edits a crew with ordinary text", async () => {
    const { o, friend } = await owner()
    const made = await create(o, friend, { name: "Saturday Lot", bio: "Quiz nights and long walks." })
    expect(made.status).toBe(201)
    const crewId = made.body.data.crewId as string
    const edited = await call(crewRoute.PATCH, `/api/mobile/crews/${crewId}`, o, "PATCH", { bio: "Quiz nights." }, { crewId })
    expect(edited.status).toBe(200)
  })
})
