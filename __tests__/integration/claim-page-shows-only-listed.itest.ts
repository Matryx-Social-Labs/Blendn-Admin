/*
 * The public claim page shows only events a stranger could have found
 * (SCRUM-455).
 *
 * `/claim/<id>` is unauthenticated on purpose -- the person it is for has no
 * account. It loaded any event that was not deleted, so a draft, a private
 * event or a cancelled one rendered its title, venue and time to anyone with
 * the link, and a draft was told "This one already has an organiser". Found on
 * staging with an admin draft (2483c8d2) the mobile API answered 404 for.
 * Filing a claim reads the same lookup, so it is refused the same way.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/auth", () => ({ getAuth: jest.fn().mockResolvedValue(null) }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
jest.mock("next/headers", () => ({ headers: jest.fn().mockResolvedValue({ get: () => "203.0.113.45" }) }))

import { fileEventClaim } from "@/lib/event-claim-actions"
import { closeDb, db, makeEvent, makeUser, testId } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const page = require("@/app/claim/[eventId]/page") as typeof import("@/app/claim/[eventId]/page")

const users: string[] = []
const events: string[] = []
const requests: string[] = []

afterAll(async () => {
  await db.event_claims.deleteMany({ where: { event_id: { in: events } } })
  await db.organiser_onboarding_requests.deleteMany({ where: { id: { in: requests } } })
  await db.events.deleteMany({ where: { id: { in: events } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

async function curated(data: { status?: "draft" | "published" | "cancelled"; visibility?: "public" | "private" | "unlisted" }) {
  const host = await makeUser("claim_page")
  users.push(host)
  const id = await makeEvent(host)
  events.push(id)
  const start = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  await db.events.update({
    where: { id },
    data: {
      curated_at: new Date(),
      start_time: start,
      end_time: new Date(start.getTime() + 3 * 60 * 60 * 1000),
      status: data.status ?? "published",
      visibility: data.visibility ?? "public",
    },
  })
  return id
}

/** A claimant with no account files through their application, as the form does. */
async function application() {
  const r = await db.organiser_onboarding_requests.create({
    data: {
      kind: "company",
      display_name: testId("claimant"),
      contact_name: "Claimant",
      contact_email: `${testId("claimant")}@itest.invalid`,
      tier: "needs_proof",
      status: "pending",
      requested_role: "organizer",
    },
    select: { id: true, contact_email: true },
  })
  requests.push(r.id)
  return r
}

const render = (eventId: string) => page.default({ params: Promise.resolve({ eventId }) })
const notFound = { digest: expect.stringContaining("404") }

it.each([
  ["a draft", { status: "draft" as const }],
  ["a private event", { visibility: "private" as const }],
  ["a cancelled event", { status: "cancelled" as const }],
])("answers %s as not found, and refuses a claim on it", async (_label, state) => {
  const id = await curated(state)
  await expect(render(id)).rejects.toMatchObject(notFound)
  const app = await application()
  const filed = await fileEventClaim({ eventId: id, contactEmail: app.contact_email, onboardingId: app.id })
  expect(filed).toEqual({ ok: false, error: "Event not found" })
  expect(await db.event_claims.count({ where: { event_id: id } })).toBe(0)
})

it("still renders a published event, public or unlisted, and takes a claim on it", async () => {
  const open = await curated({})
  await expect(render(open)).resolves.toBeTruthy()
  await expect(render(await curated({ visibility: "unlisted" }))).resolves.toBeTruthy()
  const app = await application()
  const filed = await fileEventClaim({ eventId: open, contactEmail: app.contact_email, onboardingId: app.id })
  expect(filed).toMatchObject({ ok: true })
})
