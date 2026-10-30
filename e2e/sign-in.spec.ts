import { test, expect, type Page } from "@playwright/test"

import { ROLE_ACCOUNTS } from "./fixtures/auth"

/**
 * The real sign-in form, typed into, once.
 *
 * Every other spec starts from a session `global-setup.ts` minted, because
 * `POST /api/auth/callback/credentials` is limited to 5 per IP per 15 minutes
 * and the suite has more roles than that. This is the one place the door
 * itself is driven: the credentials check, the copy for each refusal, and the
 * network limit.
 *
 * ## The budget, spent in order (the config runs one worker, file order)
 *
 * Every attempt counts against the network, a success included. This file makes
 * exactly three, then two more and a sixth that the limit must refuse, so it
 * leaves the IP spent: **run it once per server** (`npm run test:e2e:local`
 * starts a fresh one; a second run against the same server fails at the first
 * test, with the rate-limit copy). No other spec signs in through the form, so
 * nothing downstream is affected.
 */
const PASSWORD = process.env.SEED_PASSWORD
const WRONG_PASSWORD = "not-the-password-0"

// Copy from app/login/page.tsx. Asserted verbatim: these strings are the
// product's answer to a person who cannot get in.
const NO_MATCH = "That email and password don't match an operator account."
const APP_ONLY = "This account is for the Blend'n app."
const RATE_LIMITED = "Too many sign-in attempts from this network."

async function submit(page: Page, email: string, password: string) {
  await page.goto("/login")
  await page.locator("#email").fill(email)
  await page.locator("#password").fill(password)
  await page.getByRole("button", { name: "Sign in" }).click()
}

const alert = (page: Page) => page.locator("#signin-error")

/** The session NextAuth would hand a page right now: `{}` when there is none. */
const sessionOf = (page: Page) =>
  page.evaluate(async () => (await (await fetch("/api/auth/session")).json()) as { user?: { role?: string } })

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("SEED_PASSWORD is required: it is the password the seeded accounts sign in with.")
})

test("a wrong password gets the one error and no session", async ({ page }) => {
  await submit(page, ROLE_ACCOUNTS.organizer.email, WRONG_PASSWORD)

  await expect(alert(page)).toContainText(NO_MATCH)
  await expect(page).toHaveURL(/\/login$/)
  expect((await sessionOf(page)).user).toBeUndefined()
})

test("a right password for an attendee is told the dashboard is not theirs, and gets no session", async ({ page }) => {
  await submit(page, ROLE_ACCOUNTS.attendee.email, PASSWORD!)

  await expect(alert(page)).toContainText(APP_ONLY)
  await expect(page).toHaveURL(/\/login$/)
  expect((await sessionOf(page)).user).toBeUndefined()
})

test("a right password lands on the dashboard with the account's role", async ({ page }) => {
  await submit(page, ROLE_ACCOUNTS.organizer.email, PASSWORD!)

  await expect(page).toHaveURL(/\/dashboard/)
  expect((await sessionOf(page)).user?.role).toBe(ROLE_ACCOUNTS.organizer.role)
})

test("the sixth attempt from one network is refused, with the limit's own copy", async ({ page }) => {
  // A made-up address, so no real account's wrong-password counter is spent.
  const nobody = "e2e.nobody@blendn.app"

  for (const attempt of [4, 5]) {
    await submit(page, nobody, WRONG_PASSWORD)
    await expect(alert(page), `attempt ${attempt} is still answered`).toContainText(NO_MATCH)
  }

  await submit(page, nobody, WRONG_PASSWORD)
  await expect(alert(page), "attempt 6 is over the limit").toContainText(RATE_LIMITED)
  expect((await sessionOf(page)).user).toBeUndefined()
})
