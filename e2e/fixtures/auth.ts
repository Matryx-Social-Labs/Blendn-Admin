import type { Page } from "@playwright/test"

/**
 * Signing in, once per role.
 *
 * ## Why this posts to the callback instead of filling the form
 *
 * The login form is a React controlled component. Driving it with CDP-level
 * typing sets the DOM value without notifying React, so `handleSubmit` reads
 * two empty strings and the request is refused — which looks exactly like a
 * broken password, and cost an afternoon proving it was not.
 *
 * Playwright's `fill()` does dispatch the events React listens for, so the form
 * *is* driveable, and `sign-in.spec.ts` drives it — sign-in is a surface worth
 * covering. Every other spec needs a session rather than a form, and paying for
 * a full page render per role per spec buys nothing.
 */
export const SEED_PASSWORD = process.env.SEED_PASSWORD ?? "Blendn-QA-2026!"

/**
 * The seeded world's accounts, by role.
 *
 * `outsider` is the one most likely to be mistaken for a bug: it holds a
 * dashboard role and belongs to no organisation, so `eventPermissions` denies
 * it everywhere. Empty screens on that account are the correct answer — and
 * without it, "an organiser can edit" passes without anyone checking that *a
 * different* organiser cannot.
 */
export const ROLE_ACCOUNTS = {
  admin: { email: "sagar.kishore@blendn.app", role: "app_admin" },
  organizer: { email: "arjun.rao@blendn.app", role: "organizer" },
  venue: { email: "fatima.sheikh@blendn.app", role: "venue_owner" },
  sponsor: { email: "meera.iyer@blendn.app", role: "sponsor" },
  outsider: { email: "daniel.weber@blendn.app", role: "organizer" },
  attendee: { email: "ananya.b@blendn.app", role: "attendee" },
} as const

export type RoleKey = keyof typeof ROLE_ACCOUNTS

/**
 * Establish a session on `page` for one seeded account.
 *
 * Returns the session the server actually issued, so a caller can assert the
 * role rather than assume the sign-in worked. A failed credentials POST still
 * returns 200, and a test that skips this check reports "the page redirected"
 * when the real answer is "you were never signed in".
 */
export async function signInAs(page: Page, key: RoleKey) {
  const { email } = ROLE_ACCOUNTS[key]

  // Any same-origin document will do; the sign-in is fetch-based from here.
  await page.goto("/login")

  return page.evaluate(
    async ([addr, password]) => {
      const csrf = await (await fetch("/api/auth/csrf")).json()
      const body = new URLSearchParams({
        csrfToken: csrf.csrfToken,
        email: addr,
        password,
        json: "true",
        callbackUrl: "/dashboard",
      })
      await fetch("/api/auth/callback/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      })
      return (await (await fetch("/api/auth/session")).json()) as {
        user?: { role?: string; email?: string }
      }
    },
    [email, SEED_PASSWORD] as const
  )
}

/** Drop the session, so the next role starts clean. */
export async function signOut(page: Page) {
  await page.context().clearCookies()
}
