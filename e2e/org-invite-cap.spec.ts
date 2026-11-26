import { randomBytes, createHash } from "crypto"

import { test, expect } from "@playwright/test"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

import { statePathFor } from "./global-setup"

/**
 * An organisation has at most 50 unanswered invites out (SCRUM-1245).
 *
 * The seeded organizer's organisation is filled to 48 pending invites through
 * Prisma (the per-sender window, 20 an hour, would stop the UI first, and has
 * its own unit test). On the Team page the organizer sends two, the 51st is
 * refused with the sentence saying to revoke old ones, and no row is written
 * for it. Revoking one in the page frees the slot, and the same address goes
 * through. Read back through Prisma at each step.
 *
 * No mail leaves CI: the e2e job sets no RESEND_API_KEY, and the spec asserts
 * the page says so before it sends anything.
 *
 * Every invite here is removed by id or exact address; the seed is untouched.
 */

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) })
const RUN = Date.now()
const address = (n: number | string) => `e2e.invite-cap.${RUN}.${n}@blendn.app`
const CAP = 50
let orgId: string | null = null

test.afterAll(async () => {
  if (orgId) await db.organisation_invites.deleteMany({ where: { org_id: orgId, email: { startsWith: `e2e.invite-cap.${RUN}.` } } })
  await db.$disconnect()
})

/** `SELECT count(*) … WHERE org_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL` (none of these has expired). */
const pendingCount = (org: string) => db.organisation_invites.count({ where: { org_id: org, accepted_at: null, revoked_at: null } })

test("the 51st pending invite is refused on the Team page, writes no row, and a revoke frees the slot", async ({ browser, baseURL }) => {
  test.setTimeout(90_000)
  const organizer = await db.user.findUniqueOrThrow({ where: { email: "organizer@blendn.app" }, select: { id: true } })
  const membership = await db.organisation_members.findFirstOrThrow({
    where: { user_id: organizer.id, org: { display_name: "Nightshift Collective" } },
    select: { org_id: true, role: true },
  })
  expect(["owner", "admin"]).toContain(membership.role)
  orgId = membership.org_id

  // Fill to two short of the cap, whatever the seed already has out.
  const already = await pendingCount(orgId)
  expect(already, "the seed leaves room for this spec").toBeLessThanOrEqual(CAP - 2)
  const seeded = Array.from({ length: CAP - 2 - already }, (_, i) => ({
    org_id: orgId!,
    email: address(`seed${i}`),
    role: "staff" as const,
    token_hash: createHash("sha256").update(randomBytes(32)).digest("hex"),
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    invited_by: organizer.id,
    grants_role: "organizer" as const,
  }))
  await db.organisation_invites.createMany({ data: seeded })
  expect(await pendingCount(orgId)).toBe(CAP - 2)

  const context = await browser.newContext({ baseURL, storageState: statePathFor("organizer") })
  const page = await context.newPage()
  await page.goto("/dashboard/organisation", { waitUntil: "domcontentloaded" })
  // Nothing is mailed from CI: the page says email is off before anything is sent.
  await expect(page.getByText("Email is not configured.")).toBeVisible()

  const panel = page.getByRole("main").locator("section", { has: page.getByRole("heading", { level: 2, name: "Nightshift Collective" }) })
  const emailBox = panel.getByPlaceholder("colleague@yourcompany.com")
  const send = async (to: string) => {
    await emailBox.fill(to)
    await panel.getByRole("button", { name: "Invite", exact: true }).click()
  }

  // The 49th and 50th go out (as links, since email is off).
  for (const n of [1, 2]) {
    await send(address(n))
    await expect(page.getByText("Invite created. Email isn’t configured — send them this link.").last()).toBeVisible()
    await expect.poll(() => db.organisation_invites.count({ where: { org_id: orgId!, email: address(n) } })).toBe(1)
  }
  expect(await pendingCount(orgId)).toBe(CAP)

  // The 51st is refused, in the page's refusal slot, and nothing is written.
  await send(address(3))
  await expect(page.getByText("50 invites are still waiting for an answer. Revoke old ones before sending more.")).toBeVisible()
  expect(await db.organisation_invites.count({ where: { org_id: orgId, email: address(3) } })).toBe(0)
  expect(await pendingCount(orgId)).toBe(CAP)

  // Revoking one in the page frees its slot; the same address now goes through.
  const victim = address(1)
  await panel.locator("div", { has: page.getByText(victim, { exact: true }) }).getByRole("button", { name: "Revoke" }).last().click()
  await expect(page.getByText("Invite revoked")).toBeVisible()
  await expect.poll(() => pendingCount(orgId!)).toBe(CAP - 1)

  await send(address(3))
  await expect.poll(() => db.organisation_invites.count({ where: { org_id: orgId!, email: address(3), revoked_at: null } })).toBe(1)
  expect(await pendingCount(orgId)).toBe(CAP)
  await context.close()
})
