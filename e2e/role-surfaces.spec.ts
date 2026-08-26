import { test, expect, chromium, type Browser } from "@playwright/test"
import { readdirSync } from "node:fs"
import { join } from "node:path"

import { ROLE_ACCOUNTS, type RoleKey } from "./fixtures/auth"
import { statePathFor } from "./global-setup"

/**
 * E3–E6 — every role against every dashboard page, in a real browser.
 *
 * ## Why a browser, when `access-matrix.spec.ts` already fetches these
 *
 * An HTTP fetch sees only what the server sent in the first flush. Half this
 * dashboard streams its tables in afterwards, and a **refusal** is often not in
 * the body at all: `redirect()` inside a server component arrives as a 200
 * carrying the shell, with the navigation issued from the client. Measuring at
 * the socket, that is indistinguishable from a page that rendered.
 *
 * That distinction is not academic — it is the specific mistake that produced
 * sixteen false findings when the access matrix was first written, and it is
 * why that spec asserts seeded row markers instead of page state. This spec
 * asks the other question, the one only a browser can answer: **once the page
 * has settled, what is actually on the screen?**
 *
 * ## What it asserts
 *
 * One property, and it is deliberately not about authorization: *a page a role
 * may not have must refuse, and a refusal must not look like a crash.*
 *
 * `/dashboard/users` is why. Its role check sat **after** the fetch it guards,
 * in the same `Promise.all` — so `getUsers` threw Forbidden before the redirect
 * could run, and an organiser opening that URL got **"Something went wrong. The
 * page failed to load."** Nothing leaked; the resolver refused exactly as it
 * should. But a correct refusal was rendered as a broken product, and no
 * server-side test could see it, because the server's answer was right.
 *
 * The authorization question stays in `access-matrix.spec.ts`, which owns row
 * markers. This is the presentation of the answer, not the answer.
 *
 * ## Not in `negative-controls.json`, deliberately
 *
 * That registry covers *structural* guards — tests that read source and assert
 * a shape — because those can pass vacuously when a regex stops matching. This
 * one drives a browser, so a wrong assertion fails on its own terms.
 *
 * It has one vacuity risk of its own, and it is guarded in-band: if every
 * navigation silently failed, `crashed` would be empty and the sweep would
 * report a pass. The two assertions at the bottom are that control — an admin
 * must reach pages, an attendee must reach none.
 *
 * The mutation was still run: restoring `/dashboard/users`'s old gate order
 * fails this spec with organizer, venue and sponsor all listed.
 */

/** Every static dashboard route on disk — dynamic segments need a real id. */
function staticDashboardRoutes(): string[] {
  const out: string[] = []
  const walk = (dir: string, url: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith("[")) continue
      const next = join(dir, entry.name)
      const nextUrl = `${url}/${entry.name}`
      if (readdirSync(next).includes("page.tsx")) out.push(nextUrl)
      walk(next, nextUrl)
    }
  }
  const root = join(__dirname, "..", "app", "dashboard")
  out.push("/dashboard")
  walk(root, "/dashboard")
  return out.sort()
}

const ROUTES = staticDashboardRoutes()
const ROLES = Object.keys(ROLE_ACCOUNTS).filter((r) => r !== "outsider") as RoleKey[]

/**
 * The copy an error boundary renders. A refusal must never produce any of it.
 *
 * **"That page did not load" is `app/dashboard/error.tsx`, and it belongs on
 * this list.** Adding that boundary very nearly disarmed this test: errors used
 * to fall through to `app/global-error.tsx` and say "Something went wrong", and
 * once they stopped saying that, the sweep would have walked past a broken page
 * and counted it as reached. The guard would have kept passing while the thing
 * it guards regressed — which is worse than never having had it.
 *
 * The general shape: a test that matches on copy is coupled to that copy, so it
 * has to move whenever the copy does. Cheap here because there are two
 * boundaries and both are in this repo.
 */
const CRASH = [
  "Something went wrong", // app/global-error.tsx
  "That page did not load", // app/dashboard/error.tsx
  "Application error",
  "Unhandled Runtime Error",
]

let browser: Browser
test.beforeAll(async () => {
  browser = await chromium.launch()
})
test.afterAll(async () => {
  await browser.close()
})

test.describe("every role, every dashboard page", () => {
  test("finds the routes at all", () => {
    // Guards the walker: an empty list would make the sweep below vacuous
    // while reporting a pass, which is the failure R16's controls exist for.
    expect(ROUTES.length).toBeGreaterThan(25)
    expect(ROUTES).toContain("/dashboard/users")
  })

  test("no page crashes for any role — a refusal is a refusal, not an error", async ({
    baseURL,
  }) => {
    test.setTimeout(300_000)
    const crashed: string[] = []
    /** Recorded rather than asserted: the map is the deliverable for E3–E6. */
    const reached: Record<string, string[]> = {}

    for (const role of ROLES) {
      const ctx = await browser.newContext({ storageState: statePathFor(role), baseURL })
      const page = await ctx.newPage()
      reached[role] = []

      for (const url of ROUTES) {
        /*
         * `networkidle`, with a raised navigation timeout.
         *
         * This suite failed exactly once, on a machine whose 15-minute load
         * average was 20 while macOS reindexed a photo library. Starved of CPU,
         * the 500ms of network silence never arrived inside the default 30s and
         * `goto` threw. The app was fine — three runs on an idle machine gave
         * byte-identical numbers — so the timeout is the thing that was wrong.
         *
         * I first replaced the wait with `domcontentloaded` plus a bounded
         * wait for the URL to change, on the reasoning that a refusal here is a
         * client-side navigation and network quiet is a timing claim rather than
         * a state one. That reasoning is fine and the change was still wrong: a
         * client redirect left pending from the previous page fires *into* the
         * next `goto` and Chromium aborts it, so the sweep died with
         * `net::ERR_ABORTED` on whichever page happened to follow a redirect.
         * `networkidle` does not have that race precisely because it waits for
         * the redirect to finish.
         *
         * A slow wait that is correct beats a fast one that is racy, and the
         * starvation case is answered by the timeout on its own.
         */
        await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 })
        const body = (await page.locator("body").innerText()).replace(/\s+/g, " ")

        const hit = CRASH.find((c) => body.includes(c))
        if (hit) crashed.push(`${role} on ${url}: "${hit}"`)
        if (new URL(page.url()).pathname === url && !hit) reached[role].push(url)
      }
      await ctx.close()
    }

    console.log(
      "reachable pages per role:\n" +
        ROLES.map((r) => `  ${r.padEnd(11)} ${reached[r].length}`).join("\n")
    )

    // The shape carries the hint: jest-style second-argument messages are a
    // Playwright idiom, and this file is Playwright — but the object keeps the
    // failure readable in the report either way.
    expect({
      crashed,
      hint:
        crashed.length > 0
          ? "A role hit an error boundary. Check the page gates BEFORE it fetches — a " +
            "resolver that throws Forbidden inside a Promise.all beats the redirect to it."
          : "",
    }).toEqual({ crashed: [], hint: "" })

    // Positive control. Without it, a run where every navigation silently
    // failed would report zero crashes and look like a pass.
    expect(reached.admin.length, "an admin must actually reach pages").toBeGreaterThan(20)
    expect(reached.attendee, "an attendee reaches no dashboard page at all").toEqual([])
  })
})
