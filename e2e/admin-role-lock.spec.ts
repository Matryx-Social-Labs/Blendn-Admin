import { test, expect, type Page } from "@playwright/test"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

/**
 * The admin role is locked to the company domain (SCRUM-1235, launch gate 10).
 *
 * Driven as an admin on Users: making a gmail attendee an admin is refused and
 * the toast says why and what to do; a company address is promoted. Both rows
 * and their audit rows are read back.
 */
test.use({ storageState: "e2e/.auth/admin.json" })

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) })
const tag = `rolelock${Date.now().toString(36)}`
const ids: string[] = []

test.afterAll(async () => {
  if (ids.length) {
    await db.audit_logs.deleteMany({ where: { resource_id: { in: ids } } })
    await db.profiles.deleteMany({ where: { id: { in: ids } } })
    await db.user.deleteMany({ where: { id: { in: ids } } })
  }
  await db.$disconnect()
})

async function attendee(email: string) {
  const { id } = await db.user.create({ data: { email, name: `${tag} ${email.split("@")[1]}`, role: "attendee", emailVerified: new Date() } })
  ids.push(id)
  return id
}

async function makeAdmin(page: Page, email: string) {
  await page.goto(`/dashboard/users?search=${encodeURIComponent(email)}`)
  await page.getByRole("row", { name: new RegExp(email) }).getByRole("button", { name: "Open menu" }).click()
  await page.getByRole("menuitem", { name: "Edit" }).click()
  await page.getByLabel("Role").click()
  await page.getByRole("option", { name: "App Admin" }).click()
  await page.getByRole("button", { name: "Save Changes" }).click()
}

const readBack = async (id: string) => ({
  role: (await db.user.findUniqueOrThrow({ where: { id }, select: { role: true } })).role,
  audit: await db.audit_logs.findMany({
    where: { resource_id: id, action: "user.role_changed" },
    select: { action: true, details: true },
  }),
})

test("a gmail attendee cannot be made an admin; a company address can", async ({ page }) => {
  const gmail = `${tag}@gmail.com`
  const company = `${tag}@matrixsociallabs.com`
  const gmailId = await attendee(gmail)
  const companyId = await attendee(company)

  await makeAdmin(page, gmail)
  await expect(
    page.getByText(
      "Only a verified @matrixsociallabs.com account can be an admin. Set up the person's company account and make that one an admin."
    )
  ).toBeVisible()
  expect(await readBack(gmailId)).toEqual({ role: "attendee", audit: [] })

  await makeAdmin(page, company)
  await expect(page.getByText("User updated successfully")).toBeVisible()
  expect(await readBack(companyId)).toEqual({
    role: "app_admin",
    audit: [{ action: "user.role_changed", details: { from: "attendee", to: "app_admin" } }],
  })
})
