/*
 * Regulars, blind offers and the door pass against real Postgres (step 12;
 * TQ-A09: RG-U01, RG-U03, RG-I01..I08, SEC-09).
 *
 *   - Who is a regular: 3+ nights in 30 at the venue, after its claim only;
 *     two check-ins on one night are one night; staff, a minor, an unknown
 *     age, a muted person, a deleted account and the venue's own people never
 *     are (RG-U01, D-7).
 *   - The send: Venue Pro asked on the server (RG-I08), owners and admins
 *     only, the words moderated (RG-I06), two a week under a lock (RG-I07),
 *     and an audience under 5 refused with no count and nothing written (D-8).
 *     The venue's answer is `{ offerId, sent }` and nothing else (RG-I01).
 *   - The counts: held back by the complement rule.
 *   - The pass: redeemed once under a race, replay refused, a stale code and
 *     another venue's staff refused alike, one a night (RG-I04, RG-U03).
 *   - The opt-in: only an explicit boolean; revoking takes the person off the
 *     venue's list on the next read; audited (RG-I02, RG-I03).
 *   - A canary name is absent from every venue-facing answer until that
 *     person opts in, page tree included (SEC-09).
 */
process.env.MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"
process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET ?? "itest-nextauth-secret-0123456789abcdefghij"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
const mockGetAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: () => mockGetAuth() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
// The venue's map form imports Leaflet's CSS, which node cannot load.
jest.mock("@/app/dashboard/venues/[id]/venue-manage", () => ({ VenueManage: () => null }))
jest.mock("@/lib/tigris", () => ({ deletePrefix: jest.fn().mockResolvedValue(0) }))

import { NextRequest } from "next/server"
import { isValidElement, type ReactElement } from "react"

import { signAccessToken } from "@/lib/mobile-auth"
import { OFFER_PUSH_BODY, OFFER_PUSH_TITLE } from "@/lib/offers/deliver"
import * as entitlementsModule from "@/lib/entitlements"
import * as passCodeModule from "@/lib/offers/pass-code"
import * as rateLimitStore from "@/lib/rate-limit-store"
import { passCode, passStep } from "@/lib/offers/pass-code"
import { venueOffersView, weekStart } from "@/lib/offers/venue"
import { resetMemoryStore } from "@/lib/rate-limit-store"
import { venueDayBounds } from "@/lib/venue-day"

import { closeDb, db, makeEvent, makeUser, occurrenceOf, onboard, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const actions = require("@/lib/offer-actions") as typeof import("@/lib/offer-actions")
const offersRoute = require("@/app/api/mobile/offers/route") as typeof import("@/app/api/mobile/offers/route")
const reportRoute = require("@/app/api/mobile/offers/[offerId]/report/route") as typeof import("@/app/api/mobile/offers/[offerId]/report/route")
const meOffersRoute = require("@/app/api/mobile/me/offers/route") as typeof import("@/app/api/mobile/me/offers/route")
const accountRoute = require("@/app/api/mobile/account/route") as typeof import("@/app/api/mobile/account/route")
const auditActions = require("@/lib/audit-actions") as typeof import("@/lib/audit-actions")
const offerRoute = require("@/app/api/mobile/offers/[offerId]/route") as typeof import("@/app/api/mobile/offers/[offerId]/route")
const regularRoute = require("@/app/api/mobile/venues/[venueId]/regular/route") as typeof import("@/app/api/mobile/venues/[venueId]/regular/route")
const venuePage = require("@/app/dashboard/venues/[id]/page") as typeof import("@/app/dashboard/venues/[id]/page")
/* eslint-enable @typescript-eslint/no-require-imports */

const DAY = 86_400_000
const users: string[] = []
const orgs: string[] = []
const venues: string[] = []
const events: string[] = []

const as = (id: string, role: "venue_owner" | "app_admin" = "venue_owner") => mockGetAuth.mockResolvedValue({ user: { id, role, signedInAt: Date.now() } })
const yearsAgo = (years: number) => new Date(Date.now() - (years * 365.25 + 30) * DAY)

/**
 * A fixture person who said yes to "Offers from places", unless `asMade`: then
 * the profile keeps what a new account gets, which is no (S-5).
 */
async function person(label: string, o: { age?: number | null; first?: string; fresh?: boolean; asMade?: boolean } = {}) {
  const id = await makeUser(testId(label))
  users.push(id)
  // Accounts under 30 days old are never in an audience (M4): fixtures are two months old unless said.
  if (!o.fresh) await db.user.update({ where: { id }, data: { createdAt: new Date(Date.now() - 60 * DAY) } })
  await onboard(id)
  const age = o.age === undefined ? 30 : o.age
  await db.profiles.update({
    where: { id },
    data: {
      name: `${o.first ?? "Test"} ${label}`,
      date_of_birth: age === null ? null : yearsAgo(age),
      age: null,
      ...(!o.asMade && { offers_from_places: true }),
    },
  })
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
}

async function dashboardUser(label: string, role: "venue_owner" | "app_admin" = "venue_owner") {
  const id = await makeUser(testId(label))
  users.push(id)
  await db.user.update({ where: { id }, data: { role } })
  return id
}

async function org(owner: string, staff: string[] = []) {
  const o = await db.organisations.create({ data: { display_name: testId("venue_org"), kind: "company", status: "verified" } })
  orgs.push(o.id)
  await db.organisation_members.create({ data: { org_id: o.id, user_id: owner, role: "owner" } })
  for (const s of staff) await db.organisation_members.create({ data: { org_id: o.id, user_id: s, role: "staff" } })
  return o.id
}

/** A claimed venue on UTC with its day turning at 06:00. */
async function venue(orgId: string | null, claimedDaysAgo = 60) {
  const v = await db.venues.create({
    data: {
      name: testId("Regulars Venue"),
      city: "Bengaluru",
      latitude: 12.97,
      longitude: 77.64,
      timezone: "UTC",
      day_reset_hour: 6,
      owner_org_id: orgId,
      claimed_at: orgId ? new Date(Date.now() - claimedDaysAgo * DAY) : null,
    },
  })
  venues.push(v.id)
  return v.id
}

async function pro(venueId: string) {
  await db.entitlements.create({
    data: { subject_kind: "venue", subject_id: venueId, product: "venue_pro", source: "grant", starts_at: new Date(Date.now() - DAY), expires_at: new Date(Date.now() + 90 * DAY) },
  })
}

/** Where today's venue day began: the regulars' window ends here. */
const today = () => venueDayBounds("UTC", 6, new Date()).start

let host = ""
/** A night out at the venue `k` days before today began, at 20:00 + `hoursLater`. */
async function night(venueId: string, userId: string, k: number, o: { kind?: "attendee" | "staff"; hoursLater?: number } = {}) {
  const eventId = await makeEvent(host)
  events.push(eventId)
  await db.events.update({ where: { id: eventId }, data: { venue_id: venueId } })
  const at = new Date(today().getTime() - k * DAY + (14 + (o.hoursLater ?? 0)) * 60 * 60 * 1000)
  await db.event_check_ins.create({
    data: { event_id: eventId, occurrence_id: await occurrenceOf(eventId), user_id: userId, kind: o.kind ?? "attendee", status: "checked_out", check_in_time: at },
  })
}

async function regular(venueId: string, userId: string, nights = [1, 2, 3]) {
  for (const k of nights) await night(venueId, userId, k)
}

const req = (url: string, token: string, method = "GET", body?: unknown) =>
  new NextRequest(`http://localhost${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body !== undefined && { body: typeof body === "string" ? body : JSON.stringify(body) }),
  })

async function openOffer(token: string, offerId: string) {
  const res = await offerRoute.GET(req(`/api/mobile/offers/${offerId}`, token), { params: Promise.resolve({ offerId }) })
  return { status: res.status, json: await res.json() }
}

async function prefs(token: string, venueId: string, body: unknown) {
  const res = await regularRoute.PUT(req(`/api/mobile/venues/${venueId}/regular`, token, "PUT", body), { params: Promise.resolve({ venueId }) })
  return { status: res.status, json: await res.json() }
}

async function until<T>(read: () => Promise<T>, check: (v: T) => boolean, timeoutMs = 5_000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = await read()
    if (check(value) || Date.now() - started > timeoutMs) return value
    await new Promise((r) => setTimeout(r, 25))
  }
}

const refusal = (p: Promise<unknown>) => p.then(() => null, (e: Error) => e.message)
const sends = (offerId: string) => db.venue_offer_sends.findMany({ where: { offer_id: offerId }, select: { user_id: true, opened_at: true, redeemed_at: true } })

// The world: venue A with exactly five regulars and every kind of near miss.
let owner = ""
let staff = ""
let admin = ""
let otherOwner = ""
let orgA = ""
let orgB = ""
const asViewer = (id: string, role: "venue_owner" | "app_admin" = "venue_owner") => ({ id, role })
let A = ""
const R: { id: string; token: string }[] = []
const misses: Record<string, string> = {}

beforeAll(async () => {
  host = await makeUser(testId("rg_host"), "organizer")
  users.push(host)
  owner = await dashboardUser("rg_owner")
  staff = await dashboardUser("rg_staff")
  admin = await dashboardUser("rg_admin", "app_admin")
  otherOwner = await dashboardUser("rg_other_owner")
  orgA = await org(owner, [staff])
  A = await venue(orgA)
  // Another venue, with its own owner: the staff of somewhere else.
  orgB = await org(otherOwner)
  await venue(orgB)

  for (let i = 0; i < 5; i++) {
    const p = await person(`rg_r${i}`, { first: `Zqcanary${i}` })
    R.push(p)
    await regular(A, p.id)
  }
  // Two check-ins on one night (20:00 and 02:00, before the 06:00 turn) are one night.
  const twice = await person("rg_twice", { first: "Zqcanarytwice" })
  await night(A, twice.id, 1)
  await night(A, twice.id, 1, { hoursLater: 6 })
  await night(A, twice.id, 2)
  misses.twice = twice.id
  const staffer = await person("rg_staffer", { first: "Zqcanarystaff" })
  for (const k of [1, 2, 3]) await night(A, staffer.id, k, { kind: "staff" })
  misses.staffer = staffer.id
  misses.minor = (await person("rg_minor", { age: 16 })).id
  await regular(A, misses.minor)
  misses.noAge = (await person("rg_noage", { age: null })).id
  await regular(A, misses.noAge)
  misses.deleted = (await person("rg_deleted")).id
  await regular(A, misses.deleted)
  await db.user.update({ where: { id: misses.deleted }, data: { deletedAt: new Date() } })
  // One of the venue's own people, checked in as a guest.
  misses.member = (await person("rg_member")).id
  await regular(A, misses.member)
  await db.organisation_members.create({ data: { org_id: orgA, user_id: misses.member, role: "staff" } })
  // Two of three nights before the 30-night window.
  misses.old = (await person("rg_old")).id
  await regular(A, misses.old, [1, 31, 32])
}, 120_000)

beforeEach(() => resetMemoryStore())

afterAll(async () => {
  await db.notifications.deleteMany({ where: { user_id: { in: users } } })
  await db.audit_logs.deleteMany({ where: { resource: "venue", resource_id: { in: venues } } })
  await db.entitlements.deleteMany({ where: { subject_kind: "venue", subject_id: { in: venues } } })
  await db.venue_offers.deleteMany({ where: { venue_id: { in: venues } } })
  await db.venue_regular_optins.deleteMany({ where: { venue_id: { in: venues } } })
  await db.venue_offer_mutes.deleteMany({ where: { venue_id: { in: venues } } })
  await db.event_check_ins.deleteMany({ where: { event_id: { in: events } } })
  await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
  await db.events.deleteMany({ where: { id: { in: events } } })
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await db.profiles.deleteMany({ where: { id: { in: users } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
}, 120_000)

describe("the send", () => {
  it("without Venue Pro, refuses on the server, naming the plan, and writes nothing (RG-I08)", async () => {
    as(owner)
    expect(await refusal(actions.sendOffer({ venueId: A, text: "First drink on the house", days: 7 }))).toMatch(/Venue Pro/)
    expect(await db.venue_offers.count({ where: { venue_id: A } })).toBe(0)
  })

  it("refuses staff, another venue’s owner and an admin", async () => {
    await pro(A)
    as(staff)
    expect(await refusal(actions.sendOffer({ venueId: A, text: "x", days: 7 }))).toMatch(/owner or admin/)
    as(otherOwner)
    expect(await refusal(actions.sendOffer({ venueId: A, text: "x", days: 7 }))).toBe("This venue isn’t yours to send offers from.")
    as(admin, "app_admin")
    expect(await refusal(actions.sendOffer({ venueId: A, text: "x", days: 7 }))).toBe("This venue isn’t yours to send offers from.")
    expect(await db.venue_offers.count({ where: { venue_id: A } })).toBe(0)
  })

  it("refuses a phone number and a banned word, saying why (RG-I06)", async () => {
    as(owner)
    expect(await refusal(actions.sendOffer({ venueId: A, text: "Free drink, call 98450 12345", days: 7 }))).toMatch(/contact details/)
    expect(await refusal(actions.sendOffer({ venueId: A, text: "Free drink for every retard here", days: 7 }))).toBe("This can’t be sent as an offer.")
    expect(await db.venue_offers.count({ where: { venue_id: A } })).toBe(0)
  })

  it("reaches exactly the regulars, answers with how many and nothing else, and delivers a push naming no venue (RG-U01, RG-I01)", async () => {
    as(owner)
    const result = await actions.sendOffer({ venueId: A, text: "First drink on the house, Thu–Sun before 10", days: 7 })
    expect(Object.keys(result).sort()).toEqual(["offerId", "reached"])
    // A band, never the number (M4).
    expect(result.reached).toBe("5–9")
    const rows = await sends(result.offerId)
    expect(rows.map((r) => r.user_id).sort()).toEqual(R.map((r) => r.id).sort())
    for (const id of Object.values(misses)) expect(rows.map((r) => r.user_id)).not.toContain(id)

    const offer = await db.venue_offers.findUniqueOrThrow({ where: { id: result.offerId } })
    expect(offer).toMatchObject({ audience_size: 5, org_id: orgA, created_by: owner })
    const audits = await db.audit_logs.findMany({ where: { resource: "venue", resource_id: A, action: "venue_offer.send" } })
    expect(audits).toHaveLength(1)
    expect(audits[0].details).toEqual({ offerId: result.offerId, reached: "5–9", days: 7 })
    // The venue's own log, so its own organisation's.
    expect(audits[0].org_id).toBe(orgA)

    const bell = await until(
      () => db.notifications.findMany({ where: { user_id: { in: R.map((r) => r.id) }, kind: "venue_offer" } }),
      (n) => n.length === 5
    )
    expect(bell).toHaveLength(5)
    for (const n of bell) {
      expect({ title: n.title, body: n.body }).toEqual({ title: OFFER_PUSH_TITLE, body: OFFER_PUSH_BODY })
      expect(n.title).toBe("You have a new offer") // L6
      expect(n.title + n.body).not.toContain("Regulars Venue")
      expect(n.data).toMatchObject({ type: "venue_offer", offerId: result.offerId })
    }
  })

  it("two a week: the third is refused, and three at once send two (RG-I07)", async () => {
    as(owner)
    await actions.sendOffer({ venueId: A, text: "Second offer", days: 3 })
    expect(await refusal(actions.sendOffer({ venueId: A, text: "Third offer", days: 3 }))).toMatch(/sent its 2 offers this week/)
    expect(await db.venue_offers.count({ where: { venue_id: A } })).toBe(2)

    const C = await venue(orgA)
    await pro(C)
    for (let i = 0; i < 5; i++) await regular(C, R[i].id)
    const results = await Promise.allSettled([1, 2, 3].map((n) => actions.sendOffer({ venueId: C, text: `Race ${n}`, days: 3 })))
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2)
    expect(await db.venue_offers.count({ where: { venue_id: C } })).toBe(2)
  })

  it("an audience under 5 is refused with no count and nothing written, and visits before the claim never count (D-7, D-8)", async () => {
    const D = await venue(orgA, 10)
    await pro(D)
    // Three regulars after the claim; six people with two nights before it and one after.
    for (let i = 0; i < 3; i++) await regular(D, R[i].id)
    for (let i = 0; i < 6; i++) {
      const p = await person(`rg_preclaim${i}`)
      await regular(D, p.id, [2, 15, 20])
    }
    as(owner)
    const message = await refusal(actions.sendOffer({ venueId: D, text: "An offer", days: 7 }))
    expect(message).toBe("Fewer than 5 regulars right now, so nothing was sent. A regular has come on 3 or more nights in the last 30.")
    expect(await db.venue_offers.count({ where: { venue_id: D } })).toBe(0)
    expect(await db.venue_offer_sends.count({ where: { venue_id: D } })).toBe(0)
    expect(await db.audit_logs.count({ where: { resource: "venue", resource_id: D } })).toBe(0)
  })

  it("an audience of 1 and an audience of 4 are refused with the same sentence (c)", async () => {
    const one = await venue(orgA)
    const four = await venue(orgA)
    await pro(one)
    await pro(four)
    await regular(one, R[0].id)
    for (let i = 0; i < 4; i++) await regular(four, R[i].id)
    as(owner)
    const [a, b] = [
      await refusal(actions.sendOffer({ venueId: one, text: "An offer", days: 7 })),
      await refusal(actions.sendOffer({ venueId: four, text: "An offer", days: 7 })),
    ]
    expect(a).toBe("Fewer than 5 regulars right now, so nothing was sent. A regular has come on 3 or more nights in the last 30.")
    expect(b).toBe(a)
    expect(await db.venue_offers.count({ where: { venue_id: { in: [one, four] } } })).toBe(0)
  })

  it("a person who muted the venue receives nothing (RG-I07)", async () => {
    const E = await venue(orgA)
    await pro(E)
    for (let i = 0; i < 5; i++) await regular(E, R[i].id)
    expect((await prefs(R[4].token, E, { offersMuted: true })).status).toBe(200)
    as(owner)
    // Four left: under the floor.
    expect(await refusal(actions.sendOffer({ venueId: E, text: "An offer", days: 7 }))).toMatch(/^Fewer than 5 regulars/)
    expect((await prefs(R[4].token, E, { offersMuted: false })).json.data).toMatchObject({ known: false, offersMuted: false })
    // A new wording: the same words twice in a minute read as a repeat (the room's spam check).
    expect((await actions.sendOffer({ venueId: E, text: "An offer, for the five of you", days: 7 })).reached).toBe("5–9")
    // A person's own choice is nobody's record (H1).
    expect(await db.audit_logs.count({ where: { user_id: R[4].id } })).toBe(0)
  })
})

describe("the person’s side and the pass", () => {
  let offerId = ""
  beforeAll(async () => {
    offerId = (await db.venue_offers.findFirstOrThrow({ where: { venue_id: A }, orderBy: { created_at: "asc" } })).id
  })

  it("lists the offer for a recipient without opening it, and 404s it for anyone else", async () => {
    const list = await offersRoute.GET(req("/api/mobile/offers", R[0].token))
    const body = await list.json()
    expect(body.data.offers.map((o: { id: string }) => o.id)).toContain(offerId)
    expect((await sends(offerId)).every((s) => s.opened_at === null)).toBe(true)
    const stranger = await person("rg_stranger")
    expect((await openOffer(stranger.token, offerId)).status).toBe(404)
  })

  it("opening counts once, and the pass carries a code that turns", async () => {
    const first = await openOffer(R[0].token, offerId)
    expect(first.status).toBe(200)
    expect(first.json.data.offer).toMatchObject({ id: offerId, state: "live", text: "First drink on the house, Thu–Sun before 10" })
    expect(first.json.data.offer.pass.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/)
    const openedAt = (await db.venue_offer_sends.findFirstOrThrow({ where: { offer_id: offerId, user_id: R[0].id } })).opened_at
    await openOffer(R[0].token, offerId)
    expect((await db.venue_offer_sends.findFirstOrThrow({ where: { offer_id: offerId, user_id: R[0].id } })).opened_at).toEqual(openedAt)
  })

  it("redeems once under a race; a replay, a stale code and another venue’s staff are refused (RG-I04, RG-U03)", async () => {
    const { json } = await openOffer(R[0].token, offerId)
    const code = json.data.offer.pass.code as string
    const send = await db.venue_offer_sends.findFirstOrThrow({ where: { offer_id: offerId, user_id: R[0].id } })

    as(otherOwner)
    expect(await refusal(actions.redeemPass({ venueId: A, code }))).toBe("That code isn’t a live pass here. Ask them to open the pass again.")
    // A code from a minute ago: a screenshot.
    as(staff)
    expect(await refusal(actions.redeemPass({ venueId: A, code: passCode(send.id, passStep(new Date()) - 2) }))).toBe(
      "That code isn’t a live pass here. Ask them to open the pass again."
    )

    const [a, b] = await Promise.allSettled([actions.redeemPass({ venueId: A, code }), actions.redeemPass({ venueId: A, code })])
    const ok = [a, b].filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ text: string }>[]
    expect(ok).toHaveLength(1)
    expect(Object.keys(ok[0].value)).toEqual(["text"])
    expect([a, b].find((r) => r.status === "rejected")).toMatchObject({ reason: { message: "This pass was already redeemed." } })
    expect(await refusal(actions.redeemPass({ venueId: A, code }))).toBe("This pass was already redeemed.")
    expect(await db.audit_logs.count({ where: { resource: "venue", resource_id: A, action: "venue_offer.redeem" } })).toBe(1)

    const after = await openOffer(R[0].token, offerId)
    expect(after.json.data.offer).toMatchObject({ state: "redeemed", pass: null })
  })

  it("one pass a night per person per venue, whichever offer", async () => {
    const second = await db.venue_offers.findFirstOrThrow({ where: { venue_id: A, text: "Second offer" } })
    const opened = await openOffer(R[0].token, second.id)
    expect(opened.json.data.offer).toMatchObject({ state: "used_tonight", pass: null })
    // Even a pass that was on screen before the first was redeemed: the index holds.
    const send = await db.venue_offer_sends.findFirstOrThrow({ where: { offer_id: second.id, user_id: R[0].id } })
    await db.venue_offer_sends.update({ where: { id: send.id }, data: { pass_seen_at: new Date() } })
    as(staff)
    expect(await refusal(actions.redeemPass({ venueId: A, code: passCode(send.id, passStep(new Date())) }))).toBe(
      "They’ve already used a pass here tonight. One a night."
    )
  })

  it("opened and redeemed are weekly totals that cannot be differenced into one offer, and no offer has results of its own (d, f, M1)", async () => {
    for (const o of (await venueOffersView(A, asViewer(owner)))!.offers) expect(Object.keys(o).sort()).toEqual(["createdAt", "endsAt", "id", "live", "reached", "text"])
    // A synthetic history on its own venue: anonymised sends (no account), times placed in the venue's weeks.
    const F = await venue(orgA)
    await pro(F)
    const W0 = weekStart("UTC", 6, new Date())
    const at = (weeksBack: number, plusHours = 0) => new Date(W0.getTime() - weeksBack * 7 * DAY + DAY + plusHours * 3600_000)
    const history = async (weeksBack: number, sent: number, opened: number) => {
      const o = await db.venue_offers.create({
        data: { venue_id: F, org_id: orgA, text: `History ${weeksBack}`, audience_size: sent, created_at: at(weeksBack), ends_at: at(weeksBack, 24 * 7) },
      })
      await db.venue_offer_sends.createMany({
        data: Array.from({ length: sent }, (_, k) => ({
          offer_id: o.id,
          venue_id: F,
          user_id: null,
          sent_at: at(weeksBack),
          opened_at: k < opened ? at(weeksBack, 1) : null,
        })),
      })
    }
    await history(3, 20, 10) // X: 10 of 20 — publishes alone
    await history(2, 15, 11) // Y: 11 of 15 — the 4 who did not open would be named
    const view = async () => (await venueOffersView(F, asViewer(owner)))!.totals
    // The review's probe: Y's week is held, and nothing later publishes Y's change alone.
    expect(await view()).toEqual({ asOf: new Date(W0.getTime() - 2 * 7 * DAY).toISOString(), sent: "10–24", opened: 10, redeemed: null })
    // Z, last week: 10 of 30. Since X's week: 45 more sent, 21 more opened, 24 not — both at the floor.
    await history(1, 30, 10)
    expect(await view()).toEqual({ asOf: W0.toISOString(), sent: "50+", opened: 31, redeemed: null })
  })

  it("another organisation’s owner gets no view of this venue; an admin does (a)", async () => {
    expect(await venueOffersView(A, asViewer(otherOwner))).toBeNull()
    expect(await venueOffersView(A, asViewer(staff))).not.toBeNull()
    expect(await venueOffersView(A, asViewer(admin, "app_admin"))).not.toBeNull()
  })

  it("a venue that changes hands shows its new owner none of the last owner’s offers, and their passes end (b)", async () => {
    const T = await venue(orgA)
    await pro(T)
    for (let i = 0; i < 5; i++) await regular(T, R[i].id)
    as(owner)
    const sent = await actions.sendOffer({ venueId: T, text: "Old owner’s offer", days: 7 })
    expect((await prefs(R[0].token, T, { known: true })).json.data).toMatchObject({ known: true })
    await db.venues.update({ where: { id: T }, data: { owner_org_id: orgB, claimed_at: new Date(Date.now() - 60 * 86_400_000) } })

    const theirs = await venueOffersView(T, asViewer(otherOwner))
    expect(theirs?.offers).toEqual([])
    expect(theirs?.totals).toEqual({ asOf: null, sent: null, opened: null, redeemed: null })
    expect(JSON.stringify(theirs)).not.toContain("Old owner’s offer")
    // The old owner no longer owns it: no view at all.
    expect(await venueOffersView(T, asViewer(owner))).toBeNull()
    // The person's pass ends with the change.
    expect((await openOffer(R[2].token, sent.offerId)).json.data.offer).toMatchObject({ state: "ended", pass: null })
    // A yes to the old owner is not a yes to the new one (M2): hidden, not deleted, and the app says so.
    expect(theirs?.known).toEqual([])
    const after = await regularRoute.GET(req(`/api/mobile/venues/${T}/regular`, R[0].token), { params: Promise.resolve({ venueId: T }) })
    expect((await after.json()).data).toMatchObject({ known: false, ownerName: expect.stringContaining("venue_org") })
    expect(await db.venue_regular_optins.count({ where: { venue_id: T, user_id: R[0].id, org_id: orgA } })).toBe(1)
    expect((await prefs(R[0].token, T, { known: true })).json.data.known).toBe(true)
    expect((await venueOffersView(T, asViewer(otherOwner)))?.known.map((k) => k.firstName)).toEqual(["Zqcanary0"])
  })
})

describe("being known as a regular (RG-I02, RG-I03, SEC-09)", () => {
  const venueFacing = async () => {
    as(owner)
    const view = JSON.stringify(await venueOffersView(A, asViewer(owner)))
    // The page tree as the server renders it, props and all: what the RSC payload would carry.
    const expand = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(expand)
      if (!isValidElement(node)) return node
      const el = node as ReactElement<Record<string, unknown>>
      if (typeof el.type === "function" && ["VenueInsights", "RegularsOffers"].includes(el.type.name)) return expand((el.type as (p: unknown) => unknown)(el.props))
      return { ...el, props: { ...el.props, children: expand(el.props.children) } }
    }
    const el = await venuePage.default({ params: Promise.resolve({ id: A }), searchParams: Promise.resolve({}) })
    const page = JSON.stringify(expand(el), (k, value) => (k === "type" || k === "_owner" || typeof value === "function" ? undefined : value))
    return view + page
  }

  it("the venue sees no regular’s name, id or email until they say yes", async () => {
    const seen = await venueFacing()
    expect(seen).toContain("Regulars &") // the panel is there
    for (const r of R) {
      expect(seen).not.toContain(r.id)
      expect(seen).not.toContain(`${r.id}@itest.invalid`)
    }
    expect(seen).not.toMatch(/Zqcanary/)
  })

  it("only an explicit boolean changes anything", async () => {
    for (const body of [{}, { known: "true" }, { known: 1 }, { known: true, extra: 1 }, "not json"]) {
      expect((await prefs(R[1].token, A, body)).status).toBe(400)
    }
    expect(await db.venue_regular_optins.count({ where: { venue_id: A } })).toBe(0)
  })

  it("yes puts them on the venue’s list by first name; taking it back takes them off on the next read; nothing is audited (H1)", async () => {
    const yes = await prefs(R[1].token, A, { known: true })
    expect(yes).toMatchObject({ status: 200, json: { data: { known: true, offersMuted: false } } })
    as(owner)
    expect((await venueOffersView(A, asViewer(owner)))?.known).toEqual([{ firstName: "Zqcanary1", nights: 3 }])
    const seen = await venueFacing()
    expect(seen).toContain("Zqcanary1")
    expect(seen).not.toMatch(/Zqcanary[02-4]/)
    expect(seen).not.toContain(R[1].id)

    expect((await prefs(R[1].token, A, { known: false })).json.data.known).toBe(false)
    expect((await venueOffersView(A, asViewer(owner)))?.known).toEqual([])
    expect(await venueFacing()).not.toMatch(/Zqcanary/)
    // Nothing of either choice in the audit log (H1); the row's created_at was the consent.
    expect(await db.audit_logs.count({ where: { user_id: R[1].id } })).toBe(0)
  })

  it("a person’s choice written before this rule never reaches an organisation’s audit log; an admin still sees it (H1)", async () => {
    // A row the old code would have written: the person's own opt-in, on the venue, in the venue's organisation.
    await db.audit_logs.create({ data: { user_id: R[2].id, org_id: orgA, action: "venue_regular.optin", resource: "venue", resource_id: A } })
    await db.audit_logs.create({ data: { user_id: R[2].id, org_id: orgA, action: "venue_offer.mute", resource: "venue", resource_id: A } })
    as(owner)
    const theirs = await auditActions.getAuditLog({})
    expect(theirs.entries.map((e) => e.action)).not.toEqual(expect.arrayContaining(["venue_regular.optin"]))
    expect(theirs.entries.map((e) => e.action)).not.toEqual(expect.arrayContaining(["venue_offer.mute"]))
    expect(theirs.entries.map((e) => e.action)).toEqual(expect.arrayContaining(["venue_offer.send"]))
    as(admin, "app_admin")
    const all = await auditActions.getAuditLog({ resource: "venue" })
    expect(all.entries.map((e) => e.action)).toEqual(expect.arrayContaining(["venue_regular.optin", "venue_offer.mute"]))
  })

  it("refuses yes at a venue nobody runs, and from someone not known to be an adult", async () => {
    const unclaimed = await venue(null)
    expect(await prefs(R[1].token, unclaimed, { known: true })).toMatchObject({ status: 409, json: { errorCode: "VENUE_UNCLAIMED" } })
    const minor = await person("rg_minor_optin", { age: 16 })
    const refused = await prefs(minor.token, A, { known: true })
    expect(refused).toMatchObject({ status: 403, json: { errorCode: "AGE_RESTRICTED" } })
    // Flow 15's reasonCode is on the event doors only; this route is not one.
    expect(refused.json).not.toHaveProperty("reasonCode")
    expect(await db.venue_regular_optins.count({ where: { venue_id: { in: [A, unclaimed] } } })).toBe(0)
  })
})

describe("review pass 2", () => {
  it("an account under 30 days old, and anyone with offers from places off, is never in an audience (M4, M6)", async () => {
    const G = await venue(orgA)
    await pro(G)
    for (let i = 0; i < 4; i++) await regular(G, R[i].id)
    const fresh = await person("rg_fresh", { fresh: true })
    await regular(G, fresh.id)
    as(owner)
    expect(await refusal(actions.sendOffer({ venueId: G, text: "First try", days: 7 }))).toMatch(/^Fewer than 5 regulars/)
    await db.user.update({ where: { id: fresh.id }, data: { createdAt: new Date(Date.now() - 31 * DAY) } })
    // Now five — until one of them turns offers from places off.
    const off = await meOffersRoute.PUT(req("/api/mobile/me/offers", R[0].token, "PUT", { enabled: false }))
    expect((await off.json()).data).toEqual({ enabled: false, pushes: false, regulars: { active: false } })
    expect((await meOffersRoute.PUT(req("/api/mobile/me/offers", R[0].token, "PUT", { enabled: "false" }))).status).toBe(400)
    expect(await refusal(actions.sendOffer({ venueId: G, text: "Second try", days: 7 }))).toMatch(/^Fewer than 5 regulars/)
    await meOffersRoute.PUT(req("/api/mobile/me/offers", R[0].token, "PUT", { enabled: true }))
    expect((await actions.sendOffer({ venueId: G, text: "Third try", days: 7 })).reached).toBe("5–9")
    expect(await db.audit_logs.count({ where: { user_id: R[0].id } })).toBe(0)
  })

  it("a new account has offers from places off, and is in no audience until it turns them on (S-5)", async () => {
    const S = await venue(orgA)
    await pro(S)
    for (let i = 0; i < 4; i++) await regular(S, R[i].id)
    const newcomer = await person("rg_asmade", { asMade: true })
    await regular(S, newcomer.id)
    expect((await meOffersRoute.GET(req("/api/mobile/me/offers", newcomer.token))).status).toBe(200)
    expect((await (await meOffersRoute.GET(req("/api/mobile/me/offers", newcomer.token))).json()).data).toEqual({ enabled: false, pushes: false, regulars: { active: false } })
    expect((await db.profiles.findUniqueOrThrow({ where: { id: newcomer.id }, select: { offers_from_places: true } })).offers_from_places).toBe(false)
    as(owner)
    expect(await refusal(actions.sendOffer({ venueId: S, text: "Before the yes", days: 7 }))).toMatch(/^Fewer than 5 regulars/)
    await meOffersRoute.PUT(req("/api/mobile/me/offers", newcomer.token, "PUT", { enabled: true }))
    expect((await actions.sendOffer({ venueId: S, text: "After the yes", days: 7 })).reached).toBe("5–9")
  })

  it("offer pushes are off until the person says yes, only a real boolean says it, and the yes keeps its time (SCRUM-628)", async () => {
    const p = await person("rg_consent")
    const url = "/api/mobile/me/offers"
    const answer = async (res: Response) => (await res.json()).data
    const row = () => db.profiles.findUniqueOrThrow({ where: { id: p.id }, select: { offers_from_places: true, offer_push_consent_at: true } })

    expect(await answer(await meOffersRoute.GET(req(url, p.token)))).toEqual({ enabled: true, pushes: false, regulars: { active: false } })
    for (const garbled of [{ pushes: "true" }, { pushes: 1 }, {}, { pushes: true, extra: 1 }]) {
      expect((await meOffersRoute.PUT(req(url, p.token, "PUT", garbled))).status).toBe(400)
    }
    expect((await row()).offer_push_consent_at).toBeNull()

    const before = Date.now()
    expect(await answer(await meOffersRoute.PUT(req(url, p.token, "PUT", { pushes: true })))).toEqual({ enabled: true, pushes: true, regulars: { active: false } })
    const at = (await row()).offer_push_consent_at!
    expect(at.getTime()).toBeGreaterThanOrEqual(before - 1000)
    expect(at.getTime()).toBeLessThanOrEqual(Date.now())
    expect(await answer(await meOffersRoute.GET(req(url, p.token)))).toEqual({ enabled: true, pushes: true, regulars: { active: false } })
    // A second yes (a retry, a double tap) is the same yes: it keeps when it was first given.
    await new Promise((r) => setTimeout(r, 20))
    expect(await answer(await meOffersRoute.PUT(req(url, p.token, "PUT", { pushes: true })))).toEqual({ enabled: true, pushes: true, regulars: { active: false } })
    expect((await row()).offer_push_consent_at).toEqual(at)
    // "Offers from places" is its own switch: off leaves the yes as it was.
    expect(await answer(await meOffersRoute.PUT(req(url, p.token, "PUT", { enabled: false })))).toEqual({ enabled: false, pushes: true, regulars: { active: false } })
    expect(await row()).toEqual({ offers_from_places: false, offer_push_consent_at: at })
    // Both at once.
    expect(await answer(await meOffersRoute.PUT(req(url, p.token, "PUT", { enabled: true, pushes: false })))).toEqual({ enabled: true, pushes: false, regulars: { active: false } })
    expect(await row()).toEqual({ offers_from_places: true, offer_push_consent_at: null })
    expect(await db.audit_logs.count({ where: { user_id: p.id } })).toBe(0)
  })

  it("the same words twice in a minute read as a repeat (M5, the room’s spam check)", async () => {
    const K = await venue(orgA)
    await pro(K)
    as(owner)
    expect(await refusal(actions.sendOffer({ venueId: K, text: "Happy hour till nine", days: 7 }))).toMatch(/^Fewer than 5 regulars/)
    expect(await refusal(actions.sendOffer({ venueId: K, text: "Happy hour till nine", days: 7 }))).toBe("This reads like a repeat. Change the offer before sending it again.")
  })

  it("refuses a web address or a bare domain, and records the refusal for admins (M5)", async () => {
    const H = await venue(orgA)
    await pro(H)
    as(owner)
    for (const text of ["Free entry, details at toit.in", "Book at https://example.com/x", "Write to us at hello@toit.in"]) {
      expect(await refusal(actions.sendOffer({ venueId: H, text, days: 7 }))).toMatch(/can’t carry contact details or links/)
    }
    const refused = await until(
      () => db.audit_logs.findMany({ where: { resource: "venue", resource_id: H, action: "venue_offer.refused" } }),
      (r) => r.length === 3
    )
    expect(refused.map((r) => (r.details as { category: string }).category)).toEqual(expect.arrayContaining(["contact:url"]))
    expect(await db.venue_offers.count({ where: { venue_id: H } })).toBe(0)
  })

  it("a recipient reports an offer once into the queue; an admin ends it, audited, and its passes stop (M5)", async () => {
    const offer = await db.venue_offers.findFirstOrThrow({ where: { venue_id: A, text: "Second offer" } })
    const report = (token: string, id = offer.id) =>
      reportRoute.POST(req(`/api/mobile/offers/${id}/report`, token, "POST", { reason: "misleading" }), { params: Promise.resolve({ offerId: id }) })
    expect((await report(R[2].token)).status).toBe(200)
    expect((await report(R[2].token)).status).toBe(409)
    const stranger = await person("rg_reporter_stranger")
    expect((await report(stranger.token)).status).toBe(404)
    const filed = await db.message_reports.findMany({ where: { message_id: offer.id } })
    expect(filed).toMatchObject([{ message_type: "venue_offer", reason: "misleading", excerpt: "Second offer", status: "pending" }])

    as(owner)
    expect(await refusal(actions.endOffer({ offerId: offer.id, reason: "Reported as misleading by a guest" }))).toBe("Forbidden")
    as(admin, "app_admin")
    expect(await refusal(actions.endOffer({ offerId: offer.id, reason: "short" }))).toBe("Say why, in a sentence.")
    await actions.endOffer({ offerId: offer.id, reason: "Reported as misleading by a guest" })
    expect(await refusal(actions.endOffer({ offerId: offer.id, reason: "Reported as misleading by a guest" }))).toBe("This offer has already ended.")
    expect(await db.audit_logs.count({ where: { resource: "venue", resource_id: A, action: "venue_offer.end", user_id: admin } })).toBe(1)
    expect((await openOffer(R[3].token, offer.id)).json.data.offer).toMatchObject({ state: "ended", pass: null })
  })

  it("writes 'on screen' at most once a minute (L5)", async () => {
    const offer = await db.venue_offers.findFirstOrThrow({ where: { venue_id: A }, orderBy: { created_at: "asc" } })
    const seen = () => db.venue_offer_sends.findFirstOrThrow({ where: { offer_id: offer.id, user_id: R[4].id } }).then((r) => r.pass_seen_at)
    await openOffer(R[4].token, offer.id)
    const first = await seen()
    await openOffer(R[4].token, offer.id)
    expect(await seen()).toEqual(first)
    await db.venue_offer_sends.updateMany({ where: { offer_id: offer.id, user_id: R[4].id }, data: { pass_seen_at: new Date(Date.now() - 2 * 60_000) } })
    await openOffer(R[4].token, offer.id)
    expect((await seen())!.getTime()).toBeGreaterThan(Date.now() - 10_000)
  })

  it("two passes showing one code are refused rather than guessed (L3)", async () => {
    const offer = await db.venue_offers.findFirstOrThrow({ where: { venue_id: A }, orderBy: { created_at: "asc" } })
    await openOffer(R[1].token, offer.id)
    await openOffer(R[2].token, offer.id)
    const spy = jest.spyOn(passCodeModule, "codeMatches").mockReturnValue(true)
    try {
      as(staff)
      expect(await refusal(actions.redeemPass({ venueId: A, code: "ABCDEF" }))).toBe("Two passes show that code right now. Wait for it to change, then type the new one.")
    } finally {
      spy.mockRestore()
    }
    expect(await db.venue_offer_sends.count({ where: { offer_id: offer.id, redeemed_at: { not: null } } })).toBe(1)
  })

  it("twenty wrong codes at once lock the door — every one counted, answered after counting — and a right code is refused while it is locked (L1, race scan)", async () => {
    const offer = await db.venue_offers.findFirstOrThrow({ where: { venue_id: A }, orderBy: { created_at: "asc" } })
    const { json } = await openOffer(R[1].token, offer.id)
    as(staff)
    const answers = await Promise.all(Array.from({ length: 20 }, () => refusal(actions.redeemPass({ venueId: A, code: "ZZZZZ2" }))))
    // The tenth to be counted and every one after it say locked, however they interleaved.
    expect(answers.filter((a) => a === "Too many wrong codes from this account. Wait five minutes, then try again.").length).toBeGreaterThanOrEqual(11)
    expect(answers.every((a) => a !== null)).toBe(true)
    expect(await refusal(actions.redeemPass({ venueId: A, code: json.data.offer.pass.code }))).toBe("Too many wrong codes from this account. Wait five minutes, then try again.")
    expect(await db.venue_offer_sends.count({ where: { offer_id: offer.id, user_id: R[1].id, redeemed_at: { not: null } } })).toBe(0)
  })

  it("a right code already in flight when the door locks is refused at the write (L1, race scan)", async () => {
    const offer = await db.venue_offers.findFirstOrThrow({ where: { venue_id: A }, orderBy: { created_at: "asc" } })
    const { json } = await openOffer(R[1].token, offer.id)
    // Clear on arrival; ten wrong codes landed before its write.
    // Arrival: this account clear, the venue under its backstop; before the write: ten wrong codes landed.
    const spy = jest.spyOn(rateLimitStore, "peek").mockResolvedValueOnce(0).mockResolvedValueOnce(0).mockResolvedValueOnce(10)
    try {
      as(staff)
      expect(await refusal(actions.redeemPass({ venueId: A, code: json.data.offer.pass.code }))).toBe("Too many wrong codes from this account. Wait five minutes, then try again.")
    } finally {
      spy.mockRestore()
    }
    expect(await db.venue_offer_sends.count({ where: { offer_id: offer.id, user_id: R[1].id, redeemed_at: { not: null } } })).toBe(0)
  })

  it("with the store unable to answer, every offers limiter refuses while an ordinary limiter still allows (fail closed, store scan)", async () => {
    const offer = await db.venue_offers.findFirstOrThrow({ where: { venue_id: A }, orderBy: { created_at: "asc" } })
    const { json } = await openOffer(R[2].token, offer.id)
    const realHit = rateLimitStore.hit
    const realPeek = rateLimitStore.peek
    const down = new rateLimitStore.StoreUnavailable("redis down")
    const hitSpy = jest.spyOn(rateLimitStore, "hit").mockImplementation((key, ms, opts) => (opts?.failClosed ? Promise.reject(down) : realHit(key, ms, opts)))
    const peekSpy = jest.spyOn(rateLimitStore, "peek").mockImplementation((key, opts) => (opts?.failClosed ? Promise.reject(down) : realPeek(key, opts)))
    try {
      as(owner)
      expect(await refusal(actions.sendOffer({ venueId: A, text: "While the store is down", days: 3 }))).toBe("This can’t be checked right now. Try again in a minute.")
      as(staff)
      expect(await refusal(actions.redeemPass({ venueId: A, code: json.data.offer.pass.code }))).toBe("This can’t be checked right now. Try again in a minute.")
      // An ordinary (fail-open) limiter on the same store still lets people through.
      expect((await offersRoute.GET(req("/api/mobile/offers", R[2].token))).status).toBe(200)
    } finally {
      hitSpy.mockRestore()
      peekSpy.mockRestore()
    }
    expect(await db.venue_offers.count({ where: { venue_id: A, text: "While the store is down" } })).toBe(0)
    expect(await db.venue_offer_sends.count({ where: { offer_id: offer.id, user_id: R[2].id, redeemed_at: { not: null } } })).toBe(0)
  })

  it("every offers entry point is limited, keyed on what the server derived (store scan)", async () => {
    const L = await venue(orgA)
    await pro(L)
    as(owner)
    const sends = ["One", "Two quiz", "Three brunch", "Four jazz", "Five pizza", "Six roast"]
    const answers = []
    for (const text of sends) answers.push(await refusal(actions.sendOffer({ venueId: L, text: `${text} night offer`, days: 3 })))
    // The sixth in a minute is refused before anything is written or audited.
    expect(answers[5]).toBe("Too many tries. Wait a minute and send again.")
    expect(await db.audit_logs.count({ where: { resource: "venue", resource_id: L } })).toBe(0)
    as(staff)
    let door = ""
    for (let i = 0; i < 31; i++) door = (await refusal(actions.redeemPass({ venueId: L, code: "ZZZZZ2" }))) ?? ""
    expect(door).toBe("Too many tries. Wait a minute and try again.")
    const offer = await db.venue_offers.findFirstOrThrow({ where: { venue_id: A }, orderBy: { created_at: "asc" } })
    const statusAfter = async (n: number, call: () => Promise<Response>) => {
      let last = 0
      for (let i = 0; i < n; i++) last = (await call()).status
      return last
    }
    expect(await statusAfter(61, () => offerRoute.GET(req(`/api/mobile/offers/${offer.id}`, R[4].token), { params: Promise.resolve({ offerId: offer.id }) }))).toBe(429)
    expect(await statusAfter(61, () => offersRoute.GET(req("/api/mobile/offers", R[4].token)))).toBe(429)
    expect(await statusAfter(31, () => regularRoute.PUT(req(`/api/mobile/venues/${A}/regular`, R[4].token, "PUT", { offersMuted: false }), { params: Promise.resolve({ venueId: A }) }))).toBe(429)
    expect(await statusAfter(31, () => meOffersRoute.PUT(req("/api/mobile/me/offers", R[4].token, "PUT", { enabled: true })))).toBe(429)
    expect(await statusAfter(21, () => reportRoute.POST(req(`/api/mobile/offers/${offer.id}/report`, R[4].token, "POST", { reason: "spam" }), { params: Promise.resolve({ offerId: offer.id }) }))).toBe(429)
  })

  it("someone outside the venue’s organisation never touches its counters (DoS scan)", async () => {
    as(otherOwner)
    const answers = await Promise.all(Array.from({ length: 20 }, () => refusal(actions.redeemPass({ venueId: A, code: "ZZZZZ2" }))))
    expect(new Set(answers)).toEqual(new Set(["That code isn’t a live pass here. Ask them to open the pass again."]))
    expect(await rateLimitStore.peek(`door-fail-venue:${A}`)).toBe(0)
    expect(await rateLimitStore.peek(`door-fail:${A}:${otherOwner}`)).toBe(0)
  })

  it("one staff account’s lock does not stop a colleague’s valid redeem (DoS scan)", async () => {
    const colleague = await dashboardUser("rg_staff2")
    await db.organisation_members.create({ data: { org_id: orgA, user_id: colleague, role: "staff" } })
    const offer = await db.venue_offers.findFirstOrThrow({ where: { venue_id: A }, orderBy: { created_at: "asc" } })
    as(staff)
    await Promise.all(Array.from({ length: 12 }, () => refusal(actions.redeemPass({ venueId: A, code: "ZZZZZ2" }))))
    expect(await rateLimitStore.peek(`door-fail:${A}:${staff}`)).toBeGreaterThanOrEqual(10)
    const { json } = await openOffer(R[4].token, offer.id)
    as(staff)
    expect(await refusal(actions.redeemPass({ venueId: A, code: json.data.offer.pass.code }))).toBe("Too many wrong codes from this account. Wait five minutes, then try again.")
    as(colleague)
    expect(await actions.redeemPass({ venueId: A, code: json.data.offer.pass.code })).toEqual({ text: "First drink on the house, Thu–Sun before 10" })
  })

  it("the venue-wide backstop trips only past 100 wrong codes, is audited for admins, and slows rather than blocks (DoS scan)", async () => {
    const accounts: string[] = []
    for (let i = 0; i < 11; i++) {
      const id = await dashboardUser(`rg_door${i}`)
      await db.organisation_members.create({ data: { org_id: orgA, user_id: id, role: "staff" } })
      accounts.push(id)
    }
    const tenWrong = async (id: string) => {
      as(id)
      await Promise.all(Array.from({ length: 10 }, () => refusal(actions.redeemPass({ venueId: A, code: "ZZZZZ2" }))))
    }
    const backstops = () => db.audit_logs.count({ where: { resource: "venue", resource_id: A, action: "venue_offer.door_backstop" } })
    for (const id of accounts.slice(0, 9)) await tenWrong(id)
    expect(await rateLimitStore.peek(`door-fail-venue:${A}`)).toBe(90)
    expect(await backstops()).toBe(0)
    for (const id of accounts.slice(9)) await tenWrong(id)
    expect(await rateLimitStore.peek(`door-fail-venue:${A}`)).toBe(110)
    const audits = await until(
      () => db.audit_logs.findMany({ where: { resource: "venue", resource_id: A, action: "venue_offer.door_backstop" } }),
      (r) => r.length > 0
    )
    expect(audits).toHaveLength(1)
    expect(audits[0].org_id).toBeNull()
  })

  it("ten sends at once produce at most the week’s two (race scan)", async () => {
    const Q = await venue(orgA)
    await pro(Q)
    for (let i = 0; i < 5; i++) await regular(Q, R[i].id)
    as(owner)
    // Ten different offers, so the room's repeat check stays out of it: the limit (5 a minute
    // per organisation and venue) and the week's quota (2, counted under the lock) decide.
    const words = ["Free nachos Monday", "Two for one on Tuesday", "Quiz night shots", "Brunch coffee on us", "Live jazz entry free",
      "Dessert with any main", "Early bird pints", "Vinyl night mocktail", "Late night pizza slice", "Sunday roast discount"]
    const results = await Promise.allSettled(words.map((text) => actions.sendOffer({ venueId: Q, text, days: 3 })))
    const reasons = results.flatMap((r) => (r.status === "rejected" ? [(r.reason as Error).message] : []))
    expect(reasons.every((m) => /sent its 2 offers this week|Too many tries/.test(m))).toBe(true)
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2)
    expect(await db.venue_offers.count({ where: { venue_id: Q } })).toBe(2)
  })

  it("Venue Pro is asked again under the lock: a plan that ends between the check and the send sends nothing (L4)", async () => {
    const J = await venue(orgA)
    for (let i = 0; i < 5; i++) await regular(J, R[i].id)
    const spy = jest.spyOn(entitlementsModule, "hasEntitlement").mockResolvedValueOnce(true)
    try {
      as(owner)
      expect(await refusal(actions.sendOffer({ venueId: J, text: "An offer", days: 7 }))).toMatch(/Venue Pro/)
    } finally {
      spy.mockRestore()
    }
    expect(await db.venue_offers.count({ where: { venue_id: J } })).toBe(0)
  })

  it("an erased account’s sends stay as counts, with no account, day-cut times and no screen trace (M3)", async () => {
    const offer = await db.venue_offers.findFirstOrThrow({ where: { venue_id: A }, orderBy: { created_at: "asc" } })
    const before = await db.venue_offer_sends.count({ where: { offer_id: offer.id } })
    await openOffer(R[3].token, offer.id)
    expect((await accountRoute.DELETE(req("/api/mobile/account", R[3].token, "DELETE"))).status).toBe(200)
    expect(await db.venue_offer_sends.count({ where: { offer_id: offer.id } })).toBe(before)
    expect(await db.venue_offer_sends.count({ where: { user_id: R[3].id } })).toBe(0)
    const anon = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM venue_offer_sends
       WHERE offer_id = ${offer.id}::uuid AND user_id IS NULL AND pass_seen_at IS NULL
         AND sent_at = date_trunc('day', sent_at) AND opened_at = date_trunc('day', opened_at)`
    expect(anon[0].n).toBe(1)
  })
})

