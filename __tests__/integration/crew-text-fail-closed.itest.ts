import { NextRequest } from "next/server"

/*
 * A crew's name, bio and tags are read by strangers, so a write OpenAI could
 * not look at is refused, not saved (SCRUM-1052 A, owner 2026-11-14), and a
 * write asks OpenAI once for all of it (D). On staging a create whose call
 * timed out saved `["sundayrunclub","fuckoff"]`. Real routes, real rows; only
 * the vendor is stood in for.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

const mockCheckTexts = jest.fn()
jest.mock("@/lib/moderation/openai-moderation", () => ({
  ...jest.requireActual("@/lib/moderation/openai-moderation"),
  checkTextContents: (...a: unknown[]) => mockCheckTexts(...a),
}))

import { signAccessToken } from "@/lib/mobile-auth"
import { conversationPair } from "@/lib/conversations"
import { cleanup, closeDb, db, makeUser, onboard, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const crewsRoute = require("@/app/api/mobile/crews/route") as typeof import("@/app/api/mobile/crews/route")
const crewRoute = require("@/app/api/mobile/crews/[crewId]/route") as typeof import("@/app/api/mobile/crews/[crewId]/route")
/* eslint-enable @typescript-eslint/no-require-imports */

type Handler = (req: NextRequest, ctx: { params: Promise<never> }) => Promise<Response>
interface Person {
  id: string
  token: string
}
type Check = { checked: true; result: { action: string; source: string; categories: object; confidence: number } | null }

const UNAVAILABLE = "Couldn’t check that just now. Try again in a moment."
const looked = (texts: string[], hide?: string): Check[] =>
  texts.map((t) => ({ checked: true, result: t === hide ? { action: "hide", source: "openai_text", categories: {}, confidence: 0.9 } : null }))
const unanswered = (reason: "timeout" | "error") => async (texts: string[]) => texts.map(() => ({ checked: false, reason }))

const users: string[] = []

beforeEach(() => mockCheckTexts.mockReset().mockImplementation(async (texts: string[]) => looked(texts)))

afterAll(async () => {
  const crews = await db.crew_members.findMany({ where: { user_id: { in: users } }, select: { crew_id: true } })
  const crewIds = crews.map((c) => c.crew_id)
  await db.crew_invites.deleteMany({ where: { crew_id: { in: crewIds } } })
  await db.chat_group_members.deleteMany({ where: { chat_group: { crew_id: { in: crewIds } } } })
  await db.chat_groups.deleteMany({ where: { crew_id: { in: crewIds } } })
  await db.crew_members.deleteMany({ where: { crew_id: { in: crewIds } } })
  await db.crews.deleteMany({ where: { id: { in: crewIds } } })
  await db.audit_logs.deleteMany({ where: { user_id: { in: users } } })
  await db.friendships.deleteMany({ where: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] } })
  await cleanup(users, [])
  await closeDb()
})

async function person(label: string): Promise<Person> {
  const id = await makeUser(testId(label))
  users.push(id)
  await onboard(id)
  await db.profiles.update({ where: { id }, data: { name: `Asha ${label}`, age: 27 } })
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
}

async function call(handler: unknown, path: string, as: Person, method: string, body: unknown, params: Record<string, string> = {}) {
  const res = await (handler as Handler)(
    new NextRequest(`http://localhost${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${as.token}` },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve(params) as Promise<never> }
  )
  return { status: res.status, body: await res.json() }
}

async function owner(label: string) {
  const [o, friend] = await Promise.all([person(`${label}-o`), person(`${label}-f`)])
  const [user1_id, user2_id] = conversationPair(o.id, friend.id)
  await db.friendships.create({ data: { user1_id, user2_id } })
  return { o, friend }
}
const create = (o: Person, friend: Person, body: Record<string, unknown>) =>
  call(crewsRoute.POST, "/api/mobile/crews", o, "POST", { revealConsent: true, inviteUserIds: [friend.id], ...body })
const edit = (o: Person, crewId: string, body: Record<string, unknown>) =>
  call(crewRoute.PATCH, `/api/mobile/crews/${crewId}`, o, "PATCH", body, { crewId })
const crewsOf = (userId: string) => db.crew_members.count({ where: { user_id: userId } })

describe("a crew write OpenAI could not check is refused", () => {
  it.each(["timeout", "error"] as const)("create: %s → 503 MODERATION_UNAVAILABLE, nothing written", async (reason) => {
    const { o, friend } = await owner(`cf-${reason}`)
    mockCheckTexts.mockImplementation(unanswered(reason))
    const res = await create(o, friend, { name: "Sunday Runners", tags: ["sundayrunclub", "fuckoff"] })
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ success: false, error: UNAVAILABLE, errorCode: "MODERATION_UNAVAILABLE" })
    expect(await crewsOf(o.id)).toBe(0)
    expect(await db.crew_invites.count({ where: { invited_user_id: friend.id } })).toBe(0)
  })

  it("create: no answer within the bound → 503, nothing written", async () => {
    const { o, friend } = await owner("cf-hang")
    mockCheckTexts.mockImplementation(() => new Promise(() => {}))
    const res = await create(o, friend, { name: "Sunday Runners", tags: ["sundayrunclub", "fuckoff"] })
    expect(res.status).toBe(503)
    expect(res.body.errorCode).toBe("MODERATION_UNAVAILABLE")
    expect(await crewsOf(o.id)).toBe(0)
  })

  it("edit: a timeout on the tags alone → 503 under `tags`, the row unchanged", async () => {
    const { o, friend } = await owner("cf-edit")
    const made = await create(o, friend, { name: "Sunday Runners", tags: ["sundayrunclub"] })
    expect(made.status).toBe(201)
    const crewId = made.body.data.crewId as string
    mockCheckTexts.mockImplementation(unanswered("timeout"))
    const res = await edit(o, crewId, { tags: ["sundayrunclub", "fuckoff"] })
    expect(res.status).toBe(503)
    expect(res.body).toMatchObject({ errorCode: "MODERATION_UNAVAILABLE", field: "tags", error: UNAVAILABLE })
    expect(res.body.reasonCode).toBeUndefined()
    expect((await db.crews.findUniqueOrThrow({ where: { id: crewId }, select: { tags: true } })).tags).toEqual(["sundayrunclub"])
  })
})

describe("one OpenAI request per crew write, mapped back to its field and tag", () => {
  it("create: a flagged tag → 400 naming the tag, nothing written; asked once", async () => {
    const { o, friend } = await owner("cf-flag")
    mockCheckTexts.mockImplementation(async (texts: string[]) => looked(texts, "fuckoff"))
    const res = await create(o, friend, { name: "Sunday Runners", bio: "Long runs.", tags: ["sundayrunclub", "fuckoff"] })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ errorCode: "VALIDATION_FAILED", reasonCode: "TEXT_NOT_ALLOWED", field: "tags", tag: "fuckoff" })
    expect(await crewsOf(o.id)).toBe(0)
    expect(mockCheckTexts).toHaveBeenCalledTimes(1)
    expect(mockCheckTexts).toHaveBeenCalledWith(["Sunday Runners", "Long runs.", "sundayrunclub", "fuckoff", "sundayrunclub fuckoff"])
  })

  it("create: clean → 201, saved; asked once for everything", async () => {
    const { o, friend } = await owner("cf-clean")
    const res = await create(o, friend, { name: "Sunday Runners", bio: "Long runs.", tags: ["sundayrunclub", "bc"] })
    expect(res.status).toBe(201)
    expect(mockCheckTexts).toHaveBeenCalledTimes(1)
    const row = await db.crews.findUniqueOrThrow({ where: { id: res.body.data.crewId }, select: { name: true, bio: true, tags: true } })
    expect(row).toEqual({ name: "Sunday Runners", bio: "Long runs.", tags: ["sundayrunclub", "bc"] })
  })

  it("edit: a flagged tag → 400 naming it, the row unchanged; a clean edit saves; each asks once", async () => {
    const { o, friend } = await owner("cf-eflag")
    const crewId = (await create(o, friend, { name: "Sunday Runners" })).body.data.crewId as string
    mockCheckTexts.mockClear().mockImplementation(async (texts: string[]) => looked(texts, "fuckoff"))
    const refused = await edit(o, crewId, { name: "Sunday Runners 2", tags: ["fuckoff", "sundayrunclub"] })
    expect(refused.status).toBe(400)
    expect(refused.body).toMatchObject({ reasonCode: "TEXT_NOT_ALLOWED", field: "tags", tag: "fuckoff" })
    expect(mockCheckTexts).toHaveBeenCalledTimes(1)
    expect(await db.crews.findUniqueOrThrow({ where: { id: crewId }, select: { name: true, tags: true } })).toEqual({ name: "Sunday Runners", tags: [] })

    mockCheckTexts.mockClear().mockImplementation(async (texts: string[]) => looked(texts))
    expect((await edit(o, crewId, { name: "Sunday Runners 2", tags: ["vancouver", "bc"] })).status).toBe(200)
    expect(mockCheckTexts).toHaveBeenCalledTimes(1)
    expect(await db.crews.findUniqueOrThrow({ where: { id: crewId }, select: { name: true, tags: true } })).toEqual({
      name: "Sunday Runners 2",
      tags: ["vancouver", "bc"],
    })
  })

  it("a phone number split across tags is still refused before OpenAI is asked", async () => {
    const { o, friend } = await owner("cf-phone")
    const res = await create(o, friend, { name: "Sunday Runners", tags: ["98450", "12345"] })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ errorCode: "VALIDATION_FAILED", field: "tags" })
    expect(res.body.tag).toBeUndefined()
    expect(mockCheckTexts).not.toHaveBeenCalled()
    expect(await crewsOf(o.id)).toBe(0)
  })
})
