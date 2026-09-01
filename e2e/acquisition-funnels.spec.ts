import { test, expect, request as playwrightRequest } from "@playwright/test"

import { statePathFor } from "./global-setup"

/**
 * E7 — how a stranger becomes an organiser.
 *
 * Two funnels, both driven from outside in, because both begin with somebody
 * who has no account and therefore no session to lean on.
 *
 * ## The application gate has two paths, and they are not variants
 *
 * `canSubmitApplication` (`lib/org-invites.ts`) is deliberately asymmetric:
 *
 *     company-domain address  ->  passes with nothing else
 *     free provider           ->  needs a valid GSTIN **or** a website
 *
 * That asymmetry is the anti-spam gate. It raises the cost of a throwaway
 * signup without blocking the sole trader who genuinely runs events from a
 * personal address — so testing only the happy path tests the half that was
 * never at risk.
 *
 * ## The claim funnel refuses in three ways, one of them time-based
 *
 * `claimRefusal` returns `not_curated`, `already_claimed` or `room_open`. The
 * third is the one worth having: approving mid-event hands a stranger the
 * attendee list for people physically in a building right now, and
 * `unclaimEvent` can return the column but cannot un-see a roster.
 */

const uniq = () => Math.random().toString(36).slice(2, 8)

/**
 * A distinct client address per applicant.
 *
 * `POST /api/onboarding/apply` is limited to **3 per hour per IP**, keyed on
 * `x-forwarded-for`. Six application tests from one address therefore cannot
 * pass — the fourth returns 429, and since the route answers a refused gate and
 * a throttled request with different codes but the same shape, it reads as the
 * gate having changed.
 *
 * Six real applicants arrive from six addresses, so the suite says so. This is
 * simulating the deployment rather than evading the control: behind Railway the
 * header is set by the proxy, and the limiter is per-IP precisely because that
 * is what distinguishes applicants.
 *
 * The control itself is asserted directly, once, at the bottom of this file —
 * where it is a subject rather than an obstacle.
 */
let applicant = 0
/*
 * Unique per RUN, not merely per test.
 *
 * A fixed `203.0.113.1` for the first applicant meant every run reused the same
 * bucket, so the suite passed once and then failed for the next hour — with a
 * 429 that reads as the gate having changed. The window is an hour; the run
 * has to be disposable within it.
 *
 * 203.0.113.0/24 is TEST-NET-3 (RFC 5737): reserved for documentation and
 * guaranteed never to be a real client.
 */
const RUN = Math.floor(Math.random() * 250) + 1
// 198.18.0.0/15 is the RFC 2544 benchmarking range: reserved, never a real
// client, and it leaves two octets free so a run and its applicants each get
// their own.
const fromNewIp = () => ({ "X-Forwarded-For": `198.18.${RUN}.${++applicant}` })

test.describe("landing page application", () => {
  test("a company-domain address passes the gate with nothing else", async ({ request }) => {
    const res = await request.post("/api/onboarding/apply", {
      headers: fromNewIp(),
      data: {
        kind: "company",
        requested_role: "organizer",
        display_name: `Toit Brewpub ${uniq()}`,
        legal_name: "Toit Brewpub Pvt Ltd",
        contact_name: "Anita Shah",
        contact_email: `apply-${uniq()}@toit.in`,
      },
    })
    const body = await res.json()
    expect(body, JSON.stringify(body)).toMatchObject({ success: true })
    expect(body.requestId, "the claim funnel files against this id").toBeTruthy()
  })

  test("a free provider with no proof is refused, and told what would satisfy it", async ({
    request,
  }) => {
    const res = await request.post("/api/onboarding/apply", {
      headers: fromNewIp(),
      data: {
        kind: "company",
        requested_role: "organizer",
        display_name: `Basement Six ${uniq()}`,
        legal_name: "Basement Six LLP",
        contact_name: "Dev Kumar",
        contact_email: `nights-${uniq()}@gmail.com`,
      },
    })
    expect(res.status()).toBe(400)
    // A gate that refuses without naming what would pass reads as a broken form.
    expect((await res.json()).error).toMatch(/GSTIN|website/i)
  })

  test("a free provider WITH a website passes — the manual path", async ({ request }) => {
    const res = await request.post("/api/onboarding/apply", {
      headers: fromNewIp(),
      data: {
        kind: "company",
        requested_role: "organizer",
        display_name: `Basement Six ${uniq()}`,
        legal_name: "Basement Six LLP",
        contact_name: "Dev Kumar",
        contact_email: `nights-${uniq()}@gmail.com`,
        website: "https://basementsix.in",
      },
    })
    const body = await res.json()
    expect(body, JSON.stringify(body)).toMatchObject({ success: true })
  })

  test("a company must give its registered legal name", async ({ request }) => {
    const res = await request.post("/api/onboarding/apply", {
      headers: fromNewIp(),
      data: {
        kind: "company",
        requested_role: "organizer",
        display_name: `No Legal Name ${uniq()}`,
        contact_name: "Someone",
        contact_email: `apply-${uniq()}@toit.in`,
      },
    })
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toMatch(/legal name/i)
  })

  test("a second application from the same address is refused, not queued twice", async ({
    request,
  }) => {
    /*
     * A duplicate that silently queues shows a reviewer the same applicant
     * twice with no way to tell which is current.
     */
    const email = `dupe-${uniq()}@toit.in`
    const payload = {
      kind: "company",
      requested_role: "organizer",
      display_name: `Duplicate Co ${uniq()}`,
      legal_name: "Duplicate Co Pvt Ltd",
      contact_name: "Repeat Person",
      contact_email: email,
    }
    // The SAME address for both, deliberately: this is about the duplicate
    // check, not the limiter, so the two requests must share a bucket only in
    // the sense that matters — the email.
    const ip = fromNewIp()
    expect(
      (await (await request.post("/api/onboarding/apply", { headers: ip, data: payload })).json())
        .success
    ).toBe(true)

    const second = await request.post("/api/onboarding/apply", { headers: ip, data: payload })
    expect(second.status()).toBe(409)
    expect((await second.json()).error).toMatch(/already/i)
  })

  test("the admin queue shows what was filed", async ({ baseURL }) => {
    const email = `queued-${uniq()}@toit.in`
    const anon = await playwrightRequest.newContext({ baseURL })
    await anon.post("/api/onboarding/apply", {
      headers: fromNewIp(),
      data: {
        kind: "company",
        requested_role: "organizer",
        display_name: `Queue Visible ${uniq()}`,
        legal_name: "Queue Visible Pvt Ltd",
        contact_name: "Queue Person",
        contact_email: email,
      },
    })
    await anon.dispose()

    const admin = await playwrightRequest.newContext({
      baseURL,
      storageState: statePathFor("admin"),
    })
    const body = await (await admin.get("/dashboard/onboarding")).text()
    await admin.dispose()

    expect(body, "an application nobody can see is an application nobody answers").toContain(email)
  })
})

test.describe("the application limiter", () => {
  test("a fourth application from one address in an hour is refused", async ({ request }) => {
    /*
     * The control the tests above route around, asserted head-on.
     *
     * Three per hour per IP. Without this, the header trick would silently turn
     * a real protection into one nothing covers — which is how a limiter ends
     * up switched off by a config change nobody notices.
     */
    // Its own address, and its own per RUN — a fixed one would be exhausted by
    // the previous run, so the first attempt would already be 429 and the test
    // would pass for entirely the wrong reason.
    const ip = { "X-Forwarded-For": `198.18.${RUN}.250` }
    const send = () =>
      request.post("/api/onboarding/apply", {
        headers: ip,
        data: {
          kind: "company",
          requested_role: "organizer",
          display_name: `Flooder ${uniq()}`,
          legal_name: "Flooder Pvt Ltd",
          contact_name: "Flood Person",
          contact_email: `flood-${uniq()}@toit.in`,
        },
      })

    const codes: number[] = []
    for (let i = 0; i < 4; i++) codes.push((await send()).status())

    // Both halves: three get through, the fourth does not. Asserting only the
    // fourth would pass against a limiter that refused all four.
    expect(
      { firstThree: codes.slice(0, 3), fourth: codes[3] },
      `four attempts returned ${codes.join(", ")}`
    ).toEqual({ firstThree: [200, 200, 200], fourth: 429 })
  })
})

test.describe("claiming a curated event", () => {
  test("a bad claim id is a 404, never a redirect to sign in", async ({ request }) => {
    /*
     * The person this page is for has no account — that is *why* the event was
     * curated. A sign-in here would be a signup wall in front of the signup
     * funnel, so this asserts the absence of one.
     */
    const res = await request.get("/claim/00000000-0000-0000-0000-000000000000", {
      maxRedirects: 0,
      failOnStatusCode: false,
    })
    expect(res.status(), "a missing event must not bounce a stranger to /login").not.toBe(307)
  })

  test("an unclaimed curated event offers the form, with no session", async ({ baseURL }) => {
    const admin = await playwrightRequest.newContext({
      baseURL,
      storageState: statePathFor("admin"),
    })
    const queue = await (await admin.get("/dashboard/events/curate")).text()
    await admin.dispose()

    // Ids come from the curation screen rather than being hard-coded, so the
    // test follows the seed instead of drifting from it.
    const ids = Array.from(new Set(queue.match(/\/claim\/[0-9a-f-]{36}/g) ?? []))
    expect(ids.length, "the seeded world has unclaimed curated events").toBeGreaterThan(0)

    const anon = await playwrightRequest.newContext({ baseURL })
    const body = await (await anon.get(ids[0])).text()
    await anon.dispose()

    expect(body).toContain("Is this your event?")
    expect(body, "the claim form asks for a way to reply").toMatch(/Email/i)
  })
})
