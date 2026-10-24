/*
 * A claimant already over their own limits does not spend the event's bucket
 * (security audit 2026-10-24, WEB L5): filing is anonymous, so the per-event
 * window is the one a flooder would burn to keep the real claimant out.
 */
let ip = "203.0.113.1"
jest.mock("next/headers", () => ({ headers: async () => new Headers({ "x-real-ip": ip }) }))

import { overClaimLimit } from "@/lib/claim-limit"
import { peek } from "@/lib/rate-limit-store"

const run = Math.random().toString(36).slice(2)
const target = { kind: "event" as const, id: `event-${run}` }

it("stops counting against the event once the caller's address is over its own limit", async () => {
  ip = `203.0.113.${(Math.floor(Math.random() * 200) + 20)}`
  const outcomes: (string | null)[] = []
  for (let i = 0; i < 14; i++) outcomes.push(await overClaimLimit(`flood-${run}-${i}@x.test`, target))
  // The address allows 10 an hour; the other four are refused...
  expect(outcomes.slice(0, 10).every((o) => o === null)).toBe(true)
  expect(outcomes.slice(10).every((o) => o !== null)).toBe(true)
  // ...and only the ten that passed were held against the event.
  expect(await peek(`rl:claim:event:${target.id}:${ip}`)).toBe(10)
})

it("does not let several networks together drain an event's claims", async () => {
  const shared = { kind: "event" as const, id: `event-many-${run}` }
  // Three networks, ten claims each: one event, thirty claims in the hour. Each network is inside its own limits.
  for (const net of [1, 2, 3]) {
    ip = `198.51.${100 + Math.floor(Math.random() * 100)}.${net}`
    for (let i = 0; i < 10; i++) expect(await overClaimLimit(`many-${run}-${net}-${i}@x.test`, shared)).toBeNull()
  }
})
