/*
 * A lead's `ip` and `user_agent` go after a year, without anyone running
 * anything (SCRUM-431).
 *
 * docs/LEADS.md promised a 365-day retention for both, and the only thing that
 * enforced it was `scripts/purge-lead-pii.ts`, which nothing scheduled — "Not
 * yet scheduled. Run it manually" — so every lead kept both indefinitely. Now
 * the retention sweeper, which `startBackgroundWork` runs on boot and every
 * six hours, clears them. The lead itself stays: status, email and
 * notes are the record of a business conversation.
 */
import { db, closeDb, testId } from "./helpers"
import { purgeLeadPii } from "@/lib/leads"
import {
  startNotificationRetentionSweeper,
  stopNotificationRetentionSweeper,
} from "@/lib/notification-retention"

const DAY = 24 * 60 * 60 * 1000
// The number docs/LEADS.md promises, written out so a changed constant fails here.
const YEAR = 365
const ids: string[] = []

afterAll(async () => {
  stopNotificationRetentionSweeper()
  await db.leads.deleteMany({ where: { id: { in: ids } } })
  await closeDb()
})

async function lead(ageDays: number, pii: { ip?: string | null; user_agent?: string | null } = {}) {
  const email = `${testId("lead")}@example.com`
  const row = await db.leads.create({
    data: {
      type: "demo_request",
      email,
      email_root: email,
      name: "Sam Rivera",
      organization: "Filter Coffee",
      event_types: "meetups",
      city: "Bengaluru",
      open_key: `demo_request:${email}`,
      ip: "203.0.113.7",
      user_agent: "Mozilla/5.0 itest",
      ...pii,
      // The caller's clock, not ours: the age is when the row landed.
      submitted_at: new Date(),
      created_at: new Date(Date.now() - ageDays * DAY),
    },
  })
  ids.push(row.id)
  return row.id
}

const read = (id: string) =>
  db.leads.findUniqueOrThrow({
    where: { id },
    select: {
      ip: true, user_agent: true, email: true, status: true, name: true,
      organization: true, event_types: true, city: true, open_key: true,
    },
  })

// Runs the whole retention sweep, so it prunes old rows in other tables too:
// point it at a test database. Up to 15s because the lead purge is its last step.
async function until(check: () => Promise<boolean>, ms = 15_000) {
  for (const start = Date.now(); Date.now() - start < ms; ) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error("timed out")
}

it("the background sweep clears a year-old lead's ip and user agent, and keeps the lead", async () => {
  const old = await lead(YEAR + 1)
  const recent = await lead(YEAR - 1)

  // The sweeper `startBackgroundWork` runs, not the purge called by hand.
  startNotificationRetentionSweeper()
  await until(async () => (await read(old)).ip === null)
  stopNotificationRetentionSweeper()

  const cleared = await read(old)
  expect(cleared).toMatchObject({
    ip: null,
    user_agent: null,
    status: "new",
    name: "Sam Rivera",
    organization: "Filter Coffee",
    event_types: "meetups",
    city: "Bengaluru",
  })
  expect(cleared.open_key).toBe(`demo_request:${cleared.email}`)
  expect(await read(recent)).toMatchObject({ ip: "203.0.113.7", user_agent: "Mozilla/5.0 itest" })
})

it("clears a lead holding only one of the two, and a second pass changes nothing", async () => {
  const onlyAgent = await lead(YEAR + 30, { ip: null })
  // The ingest route stores a null user agent when the request carries none.
  const onlyIp = await lead(YEAR + 30, { user_agent: null })

  expect(await purgeLeadPii()).toBeGreaterThanOrEqual(2)
  expect(await read(onlyAgent)).toMatchObject({ ip: null, user_agent: null })
  expect(await read(onlyIp)).toMatchObject({ ip: null, user_agent: null })
  expect(await purgeLeadPii()).toBe(0)
})
