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
 *
 * Review round (step 6b):
 * - the pending-report dedupe not caught                → "files one report per person per post" (500)
 * - the daily report limit removed                      → "day's thirty"
 * - the `reported` stamp not written                    → "keeps a reported post through withdrawal…"
 * - erasure scrubbing a reported ask's message          → "keeps a reported ask's words"
 * - removal skipping an already-withdrawn post          → "keeps a reported post…" (stays unmarked)
 * - removal of an erased post allowed                   → "refuses to remove a post that is gone"
 * - dismiss keeping the stamp                           → "releases the post when its last pending report…"
 * - reach narrowed to people who can read the board now → "changed their RSVP to not going"
 * - the blocked list returning the raw id               → "lists an opaque ref"
 * - unblock-by-ref without the ownership predicate      → "lists an opaque ref"
 * - no excerpt snapshot                                 → "keeps a reported post…"
 * - the audit's `removed` always true                   → "keeps a reported post…"
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
let session: { user: { id: string; role: DashboardRole } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: () => Promise.resolve(session) }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { getReportQueue, resolveReport } from "@/app/dashboard/moderation/reports/actions"
import { boardWriteDenial } from "@/lib/board-access"
import { signAccessToken } from "@/lib/mobile-auth"
import { hit } from "@/lib/rate-limit-store"
import { cleanup, closeDb, db, makeEvent, makeUser, onboard, testId } from "./helpers"
/* eslint-disable @typescript-eslint/no-require-imports */
const postReport = require("@/app/api/mobile/events/[eventId]/board/[postId]/report/route") as typeof import("@/app/api/mobile/events/[eventId]/board/[postId]/report/route")
const postBlock = require("@/app/api/mobile/events/[eventId]/board/[postId]/block/route") as typeof import("@/app/api/mobile/events/[eventId]/board/[postId]/block/route")
const askReport = require("@/app/api/mobile/board/requests/[requestId]/report/route") as typeof import("@/app/api/mobile/board/requests/[requestId]/report/route")
const askBlock = require("@/app/api/mobile/board/requests/[requestId]/block/route") as typeof import("@/app/api/mobile/board/requests/[requestId]/block/route")
const boardRoute = require("@/app/api/mobile/events/[eventId]/board/route") as typeof import("@/app/api/mobile/events/[eventId]/board/route")
const postRoute = require("@/app/api/mobile/events/[eventId]/board/[postId]/route") as typeof import("@/app/api/mobile/events/[eventId]/board/[postId]/route")
const askRoute = require("@/app/api/mobile/events/[eventId]/board/[postId]/requests/route") as typeof import("@/app/api/mobile/events/[eventId]/board/[postId]/requests/route")
const myRequests = require("@/app/api/mobile/board/requests/route") as typeof import("@/app/api/mobile/board/requests/route")
const decide = require("@/app/api/mobile/board/requests/[requestId]/route") as typeof import("@/app/api/mobile/board/requests/[requestId]/route")
const blockedList = require("@/app/api/mobile/users/blocked/route") as typeof import("@/app/api/mobile/users/blocked/route")
const userBlock = require("@/app/api/mobile/users/[userId]/block/route") as typeof import("@/app/api/mobile/users/[userId]/block/route")
const account = require("@/app/api/mobile/account/route") as typeof import("@/app/api/mobile/account/route")
/* eslint-enable @typescript-eslint/no-require-imports */

type Person = { id: string; token: string }

const users: string[] = []
const events: string[] = []
const reports: string[] = []
let eventId = ""

afterAll(async () => {
  await db.message_requests.deleteMany({ where: { OR: [{ sender_id: { in: users } }, { recipient_id: { in: users } }] } })
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

const req = (url: string, token: string, body?: object, method = "POST") =>
  new NextRequest(`http://localhost${url}`, {
    method,
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

/** Somebody who can take part: onboarded, adult, going. */
async function going(label: string): Promise<Person> {
  const p = await person(label, true)
  await onboard(p.id)
  const born = new Date()
  born.setFullYear(born.getFullYear() - 30)
  await db.profiles.update({ where: { id: p.id }, data: { date_of_birth: born } })
  return p
}

const boardIds = async (who: Person) => {
  const res = await boardRoute.GET(req(`/api/mobile/events/${eventId}/board`, who.token, undefined, "GET"), {
    params: Promise.resolve({ eventId }),
  })
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: { posts: { id: string }[] } }).data.posts.map((p) => p.id)
}

describe("safety actions stay reachable when the board does not (D-c)", () => {
  it("reports and blocks back after being blocked by the author", async () => {
    const author = await person("dc-author", true)
    const viewer = await person("dc-viewer", true)
    const postId = await offer(author)
    await db.blocked_users.create({ data: { blocker_id: author.id, blocked_id: viewer.id } })
    expect((await reportPost(viewer, postId)).status).toBe(201)
    expect((await blockByPost(viewer, postId)).status).toBe(200)
    expect(await db.blocked_users.count({ where: { blocker_id: viewer.id, blocked_id: author.id } })).toBe(1)
  })

  it("reports after the doors open", async () => {
    const host = await makeUser(testId("dc-host"), "organizer")
    users.push(host)
    const at = await makeEvent(host) // started an hour ago
    events.push(at)
    const author = await person("dc-author2", false)
    const viewer = await person("dc-viewer2", false)
    await db.event_rsvps.create({ data: { event_id: at, user_id: viewer.id, status: "going" } })
    const postId = (
      await db.board_posts.create({ data: { event_id: at, author_id: author.id, kind: "chat", body: "x" }, select: { id: true } })
    ).id
    const res = await postReport.POST(req(`/api/mobile/events/${at}/board/${postId}/report`, viewer.token, { reason: "spam" }), {
      params: Promise.resolve({ eventId: at, postId }),
    })
    expect(res.status).toBe(201)
  })

  it("lets somebody who changed their RSVP to not going still report", async () => {
    const author = await person("dc-author3", true)
    const viewer = await person("dc-viewer3", false)
    await db.event_rsvps.create({ data: { event_id: eventId, user_id: viewer.id, status: "not_going" } })
    expect((await reportPost(viewer, await offer(author))).status).toBe(201)
  })
})

describe("report abuse (review #5)", () => {
  it("files one report per person per post while it is pending, and counts the people", async () => {
    const author = await person("ab-author", true)
    const one = await person("ab-one", true)
    const two = await person("ab-two", true)
    const postId = await offer(author)
    const [a, b] = await Promise.all([reportPost(one, postId), reportPost(one, postId)])
    expect([a.status, b.status]).toEqual([201, 201])
    expect(await db.message_reports.count({ where: { message_id: postId, reporter_id: one.id } })).toBe(1)
    expect((await reportPost(two, postId)).status).toBe(201)

    await asAdmin()
    const report = await lastReport(two, postId)
    expect((await queueRow(report.id))?.sameSubject).toBe(2)
  })

  it("refuses with 429 once the minute's limit is spent", async () => {
    const author = await person("rl-author", true)
    const viewer = await person("rl-viewer", true)
    const posts: string[] = []
    for (let n = 0; n < 44; n++) posts.push(await offer(author))
    // A fixed window can reset mid-probe, so probe until the first 429, at
    // most two windows' worth (limit 20, +2, doubled).
    let refused = -1
    for (let n = 0; n < posts.length; n++) {
      const res = await reportPost(viewer, posts[n])
      if (res.status === 429) {
        refused = n
        break
      }
      expect(res.status).toBe(201)
    }
    expect(refused).toBeGreaterThanOrEqual(0)
  })

  it("refuses with 429 once the day's thirty are spent", async () => {
    const author = await person("rd-author", true)
    const viewer = await person("rd-viewer", true)
    for (let n = 0; n < 30; n++) await hit(`rl:report-board-day:${viewer.id}`, 24 * 60 * 60 * 1000)
    const res = await reportPost(viewer, await offer(author))
    expect(res.status).toBe(429)
    expect(await db.message_reports.count({ where: { reporter_id: viewer.id } })).toBe(0)
  })
})

describe("the evidence survives the author (review #4)", () => {
  it("keeps a reported post through withdrawal and account erasure, and removes it on review", async () => {
    const author = await person("ev-author", true)
    await onboard(author.id) // erasure scrubs a profile, so there has to be one
    const viewer = await person("ev-viewer", true)
    const other = await person("ev-other", true)
    const postId = await offer(author, "Two seats, girls only, insta first")
    expect((await reportPost(viewer, postId)).status).toBe(201)
    expect((await reportPost(other, postId)).status).toBe(201)
    expect((await db.board_posts.findUniqueOrThrow({ where: { id: postId } })).moderation_status).toBe("reported")

    expect(
      (await postRoute.DELETE(req(`/api/mobile/events/${eventId}/board/${postId}`, author.token, undefined, "DELETE"), {
        params: Promise.resolve({ eventId, postId }),
      })).status
    ).toBe(200)
    expect((await account.DELETE(req("/api/mobile/account", author.token, undefined, "DELETE"))).status).toBe(200)

    const kept = await db.board_posts.findUnique({ where: { id: postId } })
    expect(kept).not.toBeNull()
    expect(kept?.deleted_at).not.toBeNull()

    await asAdmin()
    const first = await lastReport(viewer, postId)
    const second = await lastReport(other, postId)
    expect(first.excerpt).toBe("Two seats, girls only, insta first")
    expect(await queueRow(first.id)).toMatchObject({ removable: true, messageDeleted: true, excerpt: "Two seats, girls only, insta first" })

    await resolveReport("message", first.id, "remove_message")
    expect((await db.board_posts.findUniqueOrThrow({ where: { id: postId } })).moderation_status).toBe("removed")
    expect((await auditRow(first.id, "report.remove_message"))?.details).toMatchObject({ removed: true })
    expect((await queueRow(second.id))?.removable).toBe(false)

    await resolveReport("message", second.id, "remove_message")
    expect((await auditRow(second.id, "report.remove_message"))?.details).toMatchObject({ removed: false })
  })

  it("keeps a reported ask's words through the asker's erasure", async () => {
    const author = await person("eva-author", true)
    const asker = await person("eva-asker", true)
    await onboard(asker.id)
    const requestId = await askOn(await offer(author), asker, author, "selling passes, dm me")
    const unreported = await askOn(await offer(author), asker, author, "plain ask")
    expect((await reportAsk(author, requestId)).status).toBe(201)
    expect((await account.DELETE(req("/api/mobile/account", asker.token, undefined, "DELETE"))).status).toBe(200)
    expect((await db.board_requests.findUniqueOrThrow({ where: { id: requestId } })).message).toBe("selling passes, dm me")
    expect((await db.board_requests.findUniqueOrThrow({ where: { id: unreported } })).message).toBeNull()
  })

  it("refuses to remove a post that is gone, and says it is gone", async () => {
    const author = await person("eg-author", true)
    const viewer = await person("eg-viewer", true)
    const postId = await offer(author)
    expect((await reportPost(viewer, postId)).status).toBe(201)
    const report = await lastReport(viewer, postId)
    await db.board_posts.delete({ where: { id: postId } })

    await asAdmin()
    expect(await queueRow(report.id)).toMatchObject({ gone: true, removable: false, excerpt: expect.any(String) })
    await expect(resolveReport("message", report.id, "remove_message")).rejects.toThrow(/no longer exists/i)
    expect((await db.message_reports.findUniqueOrThrow({ where: { id: report.id } })).status).toBe("pending")
  })

  it("releases the post when its last pending report is dismissed", async () => {
    const author = await person("ds-author", true)
    const one = await person("ds-one", true)
    const two = await person("ds-two", true)
    const postId = await offer(author)
    expect((await reportPost(one, postId)).status).toBe(201)
    expect((await reportPost(two, postId)).status).toBe(201)
    await asAdmin()
    await resolveReport("message", (await lastReport(one, postId)).id, "dismiss")
    expect((await db.board_posts.findUniqueOrThrow({ where: { id: postId } })).moderation_status).toBe("reported")
    await resolveReport("message", (await lastReport(two, postId)).id, "dismiss")
    expect((await db.board_posts.findUniqueOrThrow({ where: { id: postId } })).moderation_status).toBeNull()
  })
})

describe("a removed post is gone everywhere, through the routes", () => {
  it("leaves every board, every list, every ask, the cap and the reviewed tab saying so", async () => {
    const author = await going("rm-author")
    const viewer = await going("rm-viewer")
    const asker = await going("rm-asker")
    const postId = await offer(author)
    const requestId = await askOn(postId, asker, author)
    expect(await boardIds(viewer)).toContain(postId)

    expect((await reportPost(viewer, postId)).status).toBe(201)
    const report = await lastReport(viewer, postId)
    await asAdmin()
    await resolveReport("message", report.id, "remove_message")

    expect(await boardIds(viewer)).not.toContain(postId)
    expect(await boardIds(author)).not.toContain(postId)

    const theirs = await myRequests.GET(req("/api/mobile/board/requests", asker.token, undefined, "GET"))
    const row = ((await theirs.json()) as { data: { outgoing: { id: string; live: boolean; post: { body: string | null } }[] } }).data.outgoing.find(
      (r) => r.id === requestId
    )
    expect(row).toMatchObject({ live: false, post: { body: null } })

    const again = await askRoute.POST(req(`/api/mobile/events/${eventId}/board/${postId}/requests`, viewer.token, {}), {
      params: Promise.resolve({ eventId, postId }),
    })
    expect(again.status).toBe(404)

    const accept = await decide.PATCH(req(`/api/mobile/board/requests/${requestId}`, author.token, { action: "accept" }, "PATCH"), {
      params: Promise.resolve({ requestId }),
    })
    expect(accept.status).toBe(409)
    expect((await accept.json()).error).toBe("That post was taken down")

    // The ask stopped holding a slot: nothing outstanding for the asker.
    expect(await boardWriteDenial(eventId, asker.id)).not.toBe("too_many_outstanding")

    // Still reportable and blockable, as documented.
    expect((await reportPost(asker, postId)).status).toBe(201)
    expect((await blockByPost(asker, postId)).status).toBe(200)

    const { rows } = await getReportQueue("resolved")
    expect(rows.find((r) => r.id === report.id)).toMatchObject({ messageDeleted: true, removable: false })
  })
})

describe("blocking by post: everything a block does, and what it leaves", () => {
  it("closes the conversation, cancels message requests, leaves board asks, and repeats cleanly", async () => {
    const author = await person("bs-author", true)
    const viewer = await person("bs-viewer", true)
    const postId = await offer(author)
    const askId = await askOn(postId, viewer, author)
    const [u1, u2] = [viewer.id, author.id].sort()
    const convo = await db.private_conversations.create({ data: { user1_id: u1, user2_id: u2 }, select: { id: true } })
    await db.message_requests.create({ data: { sender_id: author.id, recipient_id: viewer.id, message: "hi" } })

    const first = await blockByPost(viewer, postId)
    const second = await blockByPost(viewer, postId)
    expect([first.status, second.status]).toEqual([200, 200])
    expect(await second.json()).toEqual(await first.json())

    const closed = await db.private_conversations.findUniqueOrThrow({ where: { id: convo.id } })
    expect(closed.closed_at).not.toBeNull()
    expect(closed.closed_reason).toBe("block")
    expect(
      await db.message_requests.count({ where: { sender_id: author.id, recipient_id: viewer.id, status: "pending" } })
    ).toBe(0)
    // Board asks are left as they are: hidden and unacceptable, not rewritten.
    expect((await db.board_requests.findUniqueOrThrow({ where: { id: askId } })).status).toBe("pending")
  })

  it("refuses your own post, and answers an outsider exactly as a missing post", async () => {
    const author = await person("bs-author2", true)
    const outsider = await person("bs-outsider", false)
    const postId = await offer(author)
    expect((await blockByPost(author, postId)).status).toBe(400)
    const [unseen, missing] = [
      await blockByPost(outsider, postId),
      await blockByPost(outsider, "00000000-0000-4000-8000-000000000000"),
    ]
    expect(unseen.status).toBe(404)
    expect(await unseen.json()).toEqual(await missing.json())
  })
})

describe("the block list never hands back the id the board withheld (review #1)", () => {
  it("lists an opaque ref, and unblocks by it — for the blocker only", async () => {
    const author = await person("bl-author", true)
    const viewer = await person("bl-viewer", true)
    const stranger = await person("bl-stranger", true)
    expect((await blockByPost(viewer, await offer(author))).status).toBe(200)

    const res = await blockedList.GET(req("/api/mobile/users/blocked", viewer.token, undefined, "GET"))
    const text = await res.text()
    expect(text).not.toContain(author.id)
    const ref = (JSON.parse(text) as { data: { users: { blocked_id: string }[] } }).data.users[0].blocked_id
    expect(ref).toMatch(/^bk_/)

    const unblock = (who: Person) =>
      userBlock.DELETE(req(`/api/mobile/users/${ref}/block`, who.token, undefined, "DELETE"), {
        params: Promise.resolve({ userId: ref }),
      })
    expect((await unblock(stranger)).status).toBe(200)
    expect(await db.blocked_users.count({ where: { blocker_id: viewer.id, blocked_id: author.id } })).toBe(1)
    expect((await unblock(viewer)).status).toBe(200)
    expect(await db.blocked_users.count({ where: { blocker_id: viewer.id, blocked_id: author.id } })).toBe(0)
  })
})
