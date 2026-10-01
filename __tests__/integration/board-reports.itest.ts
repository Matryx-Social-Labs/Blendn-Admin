import { NextRequest } from "next/server"
import type { DashboardRole } from "@/lib/dashboard-types"

/*
 * Reporting and blocking from the board, and taking a post down (SCRUM-322).
 *
 * The board never gives the client a user id, so a person is reported and
 * blocked by the post or the ask they wrote, and resolved on the server. The
 * reports land in the admin queue; the queue's Remove takes a post off the
 * board and audits it. Real routes, the real server actions, real rows.
 *
 * Mutations observed failing, each reverted:
 * - `boardPostAuthorFor` without the board-read check   → "refuses ... could not have seen"
 * - its ask-on-the-post fallback removed                → "lets somebody with an ask on it report"
 * - the post report filed as `message_type: "group"`    → "reports a post ... the queue names its author"
 * - the queue's ask subject always `ask.to`             → "reports an ask about the other person"
 * - `messageSubject`'s ask branch always `to_user_id`   → "dismissing an ask's report records who it was about"
 * - the board-post removal branch deleted               → "Remove post takes it off the board"
 * - the remove refusal widened to `board_request`       → "will not remove an ask"
 * - `boardRequestCounterpart` returning the caller      → "blocks the other person on an ask"
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
let session: { user: { id: string; role: DashboardRole } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: () => Promise.resolve(session) }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { getReportQueue, resolveReport } from "@/app/dashboard/moderation/reports/actions"
import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"
/* eslint-disable @typescript-eslint/no-require-imports */
const postReport = require("@/app/api/mobile/events/[eventId]/board/[postId]/report/route") as typeof import("@/app/api/mobile/events/[eventId]/board/[postId]/report/route")
const postBlock = require("@/app/api/mobile/events/[eventId]/board/[postId]/block/route") as typeof import("@/app/api/mobile/events/[eventId]/board/[postId]/block/route")
const askReport = require("@/app/api/mobile/board/requests/[requestId]/report/route") as typeof import("@/app/api/mobile/board/requests/[requestId]/report/route")
const askBlock = require("@/app/api/mobile/board/requests/[requestId]/block/route") as typeof import("@/app/api/mobile/board/requests/[requestId]/block/route")
/* eslint-enable @typescript-eslint/no-require-imports */

type Person = { id: string; token: string }

const users: string[] = []
const events: string[] = []
const reports: string[] = []
let eventId = ""

afterAll(async () => {
  await db.audit_logs.deleteMany({ where: { resource_id: { in: reports } } })
  await db.message_reports.deleteMany({ where: { reporter_id: { in: users } } })
  await db.blocked_users.deleteMany({
    where: { OR: [{ blocker_id: { in: users } }, { blocked_id: { in: users } }] },
  })
  await db.board_requests.deleteMany({ where: { event_id: { in: events } } })
  await db.board_posts.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

async function person(label: string, rsvp: boolean): Promise<Person> {
  const id = await makeUser(testId(label))
  users.push(id)
  if (rsvp) await db.event_rsvps.create({ data: { event_id: eventId, user_id: id, status: "going" } })
  const { email } = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  return { id, token: signAccessToken(id, email) }
}

const req = (url: string, token: string, body?: object) =>
  new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

const reportPost = (who: Person, postId: string, body: object = { reason: "harassment" }) =>
  postReport.POST(req(`/api/mobile/events/${eventId}/board/${postId}/report`, who.token, body), {
    params: Promise.resolve({ eventId, postId }),
  })
const blockByPost = (who: Person, postId: string) =>
  postBlock.POST(req(`/api/mobile/events/${eventId}/board/${postId}/block`, who.token), {
    params: Promise.resolve({ eventId, postId }),
  })
const reportAsk = (who: Person, requestId: string) =>
  askReport.POST(req(`/api/mobile/board/requests/${requestId}/report`, who.token, { reason: "spam", description: "selling passes" }), {
    params: Promise.resolve({ requestId }),
  })
const blockByAsk = (who: Person, requestId: string) =>
  askBlock.POST(req(`/api/mobile/board/requests/${requestId}/block`, who.token), {
    params: Promise.resolve({ requestId }),
  })

async function offer(author: Person, body = `Two seats from Indiranagar ${testId("b")}`) {
  return (
    await db.board_posts.create({
      data: { event_id: eventId, author_id: author.id, kind: "offer", body, spaces_left: 2 },
      select: { id: true },
    })
  ).id
}

async function askOn(postId: string, from: Person, to: Person, message: string | null = "can I come?") {
  return (
    await db.board_requests.create({
      data: { event_id: eventId, post_id: postId, from_user_id: from.id, to_user_id: to.id, ...(message && { message }) },
      select: { id: true },
    })
  ).id
}

async function lastReport(reporter: Person, messageId: string) {
  const row = await db.message_reports.findFirstOrThrow({
    where: { reporter_id: reporter.id, message_id: messageId },
    orderBy: { created_at: "desc" },
  })
  reports.push(row.id)
  return row
}

async function asAdmin() {
  const id = await makeUser(testId("br-admin"), "app_admin")
  users.push(id)
  session = { user: { id, role: "app_admin" } }
  return id
}

async function queueRow(reportId: string) {
  const { rows } = await getReportQueue("pending")
  return rows.find((r) => r.id === reportId)
}

/** `auditLog` is fire-and-forget; give the row a moment to land. */
async function auditRow(resource_id: string, action: string) {
  for (let i = 0; i < 40; i++) {
    const row = await db.audit_logs.findFirst({ where: { resource_id, action } })
    if (row) return row
    await new Promise((r) => setTimeout(r, 50))
  }
  return null
}

beforeAll(async () => {
  const host = await makeUser(testId("br-host"), "organizer")
  users.push(host)
  eventId = await makeEvent(host)
  events.push(eventId)
  const start = new Date(Date.now() + 24 * 3600_000)
  await db.events.update({
    where: { id: eventId },
    data: { start_time: start, end_time: new Date(start.getTime() + 3 * 3600_000) },
  })
})

describe("reporting a board post", () => {
  it("reports a post as somebody who can read the board, and the queue names its author", async () => {
    const author = await person("br-author", true)
    const viewer = await person("br-viewer", true)
    const postId = await offer(author, "Two seats, girls only, send me your insta first")

    const res = await reportPost(viewer, postId, { reason: "harassment", description: "pushy" })
    expect(res.status).toBe(201)
    expect(await res.text()).not.toContain(author.id)

    const report = await lastReport(viewer, postId)
    expect(report).toMatchObject({ message_type: "board_post", reason: "harassment", description: "pushy" })

    await asAdmin()
    expect(await queueRow(report.id)).toMatchObject({
      kind: "message",
      messageType: "board_post",
      boardKind: "offer",
      subjectId: author.id,
      excerpt: "Two seats, girls only, send me your insta first",
      eventId,
      messageDeleted: false,
    })
  })

  it("refuses a report from somebody who could not have seen the post — the same 404 as no post", async () => {
    const author = await person("br-author2", true)
    const stranger = await person("br-stranger", false)
    const postId = await offer(author)

    const unseen = await reportPost(stranger, postId)
    const missing = await reportPost(stranger, "00000000-0000-4000-8000-000000000000")
    expect(unseen.status).toBe(404)
    expect(await unseen.json()).toEqual(await missing.json())
    expect(await db.message_reports.count({ where: { message_id: postId } })).toBe(0)
  })

  it("lets somebody with an ask on it report it after they stopped going", async () => {
    const author = await person("br-author3", true)
    const asker = await person("br-asker3", false)
    const postId = await offer(author)
    await askOn(postId, asker, author)
    expect((await reportPost(asker, postId)).status).toBe(201)
  })

  it("refuses your own post, and a reason outside the list", async () => {
    const author = await person("br-author4", true)
    const viewer = await person("br-viewer4", true)
    const postId = await offer(author)
    expect((await reportPost(author, postId)).status).toBe(400)
    const odd = await reportPost(viewer, postId, { reason: "i just dont like them" })
    expect(odd.status).toBeGreaterThanOrEqual(400)
    expect(odd.status).toBeLessThan(500)
    expect(await db.message_reports.count({ where: { message_id: postId } })).toBe(0)
  })
})

describe("reporting a board ask", () => {
  it("reports an ask about the other person", async () => {
    const author = await person("bra-author", true)
    const asker = await person("bra-asker", true)
    const requestId = await askOn(await offer(author), asker, author, "can i come? selling passes too")

    const res = await reportAsk(author, requestId)
    expect(res.status).toBe(201)
    expect(await res.text()).not.toContain(asker.id)
    const report = await lastReport(author, requestId)
    expect(report.message_type).toBe("board_request")

    await asAdmin()
    expect(await queueRow(report.id)).toMatchObject({
      messageType: "board_request",
      subjectId: asker.id,
      excerpt: "can i come? selling passes too",
      eventId,
    })
  })

  it("refuses anybody who is not one of the ask's two people", async () => {
    const author = await person("bra-author2", true)
    const asker = await person("bra-asker2", true)
    const outsider = await person("bra-out", true)
    const requestId = await askOn(await offer(author), asker, author)
    expect((await reportAsk(outsider, requestId)).status).toBe(404)
    expect(await db.message_reports.count({ where: { message_id: requestId } })).toBe(0)
  })

  it("dismissing an ask's report records who it was about", async () => {
    const author = await person("bra-author3", true)
    const asker = await person("bra-asker3", true)
    const requestId = await askOn(await offer(author), asker, author)
    expect((await reportAsk(author, requestId)).status).toBe(201)
    const report = await lastReport(author, requestId)

    await asAdmin()
    await resolveReport("message", report.id, "dismiss")
    const audit = await auditRow(report.id, "report.dismiss")
    expect((audit?.details as { subjectId?: string } | null)?.subjectId).toBe(asker.id)
  })
})

describe("blocking from the board", () => {
  it("blocks a post's author by the post, without naming them", async () => {
    const author = await person("brb-author", true)
    const viewer = await person("brb-viewer", true)
    const postId = await offer(author)

    const res = await blockByPost(viewer, postId)
    expect(res.status).toBe(200)
    expect(await res.text()).not.toContain(author.id)
    expect(await db.blocked_users.count({ where: { blocker_id: viewer.id, blocked_id: author.id } })).toBe(1)
  })

  it("refuses a block by a post the caller could not have seen", async () => {
    const author = await person("brb-author2", true)
    const stranger = await person("brb-stranger", false)
    const postId = await offer(author)
    expect((await blockByPost(stranger, postId)).status).toBe(404)
    expect(await db.blocked_users.count({ where: { blocker_id: stranger.id } })).toBe(0)
  })

  it("blocks the other person on an ask", async () => {
    const author = await person("brb-author3", true)
    const asker = await person("brb-asker3", true)
    const requestId = await askOn(await offer(author), asker, author)

    expect((await blockByAsk(author, requestId)).status).toBe(200)
    expect(await db.blocked_users.count({ where: { blocker_id: author.id, blocked_id: asker.id } })).toBe(1)
  })
})

describe("an admin takes a reported post down", () => {
  it("Remove post takes it off the board, resolves the report and audits it", async () => {
    const author = await person("brr-author", true)
    const viewer = await person("brr-viewer", true)
    const postId = await offer(author)
    expect((await reportPost(viewer, postId)).status).toBe(201)
    const report = await lastReport(viewer, postId)

    await asAdmin()
    await resolveReport("message", report.id, "remove_message")

    const post = await db.board_posts.findUniqueOrThrow({ where: { id: postId } })
    expect(post.deleted_at).not.toBeNull()
    expect(post.moderation_status).toBe("removed")
    expect((await db.message_reports.findUniqueOrThrow({ where: { id: report.id } })).status).toBe("resolved")
    const audit = await auditRow(report.id, "report.remove_message")
    expect(audit?.details).toMatchObject({ subjectId: author.id, boardPostId: postId })
  })

  it("will not remove an ask — the lever there is the person", async () => {
    const author = await person("brr-author2", true)
    const asker = await person("brr-asker2", true)
    const requestId = await askOn(await offer(author), asker, author)
    expect((await reportAsk(author, requestId)).status).toBe(201)
    const report = await lastReport(author, requestId)

    await asAdmin()
    await expect(resolveReport("message", report.id, "remove_message")).rejects.toThrow(
      /only a room message or a board post/i
    )
    expect((await db.message_reports.findUniqueOrThrow({ where: { id: report.id } })).status).toBe("pending")
  })
})
