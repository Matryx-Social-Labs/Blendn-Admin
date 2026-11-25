/**
 * The one rule for whether a dashboard session has ended
 * (lib/session-revocation.ts; step 18 security review, M6), at its edges. The
 * integration suite drives it through NextAuth; these are the boundaries a
 * real clock rarely lands on.
 */
import { isRevoked, provenAt } from "@/lib/session-revocation"

const CHANGED = Date.parse("2026-10-11T09:30:00.000Z")
const live = { role: "organizer" as const, deletedAt: null, suspended_at: null, password_changed_at: null, sessions_revoked_at: null }
const changed = { ...live, password_changed_at: new Date(CHANGED) }

it("a session with no user is ended, however good the rest", () => {
  expect(isRevoked({ signedInAt: CHANGED + 60_000 }, live)).toBe(true)
  expect(isRevoked({ sub: "", signedInAt: CHANGED + 60_000 }, live)).toBe(true)
  expect(isRevoked({ sub: "u1", signedInAt: CHANGED + 60_000 }, live)).toBe(false)
})

it("a tie goes to the change: the same millisecond, or an iat in the same second", () => {
  expect(isRevoked({ sub: "u1", signedInAt: CHANGED }, changed)).toBe(true)
  expect(isRevoked({ sub: "u1", signedInAt: CHANGED + 1 }, changed)).toBe(false)
  expect(isRevoked({ sub: "u1", iat: CHANGED / 1000 }, changed)).toBe(true)
  expect(isRevoked({ sub: "u1", iat: CHANGED / 1000 + 1 }, changed)).toBe(false)
})

it("iat is seconds, signedInAt milliseconds, and signedInAt wins", () => {
  expect(provenAt({ iat: 1_700_000_000 })).toBe(1_700_000_000_000)
  expect(provenAt({ signedInAt: 5, iat: 1_700_000_000 })).toBe(5)
  expect(provenAt({ signedInAt: "5", iat: Number.NaN })).toBeNull()
})

it("a read that forgot the column ends the session rather than waving it through", () => {
  const unselected = { deletedAt: null, suspended_at: null } as unknown as typeof live
  expect(isRevoked({ sub: "u1", signedInAt: CHANGED }, unselected)).toBe(true)
  const noEnd = { deletedAt: null, suspended_at: null, password_changed_at: null } as unknown as typeof live
  expect(isRevoked({ sub: "u1", signedInAt: CHANGED }, noEnd)).toBe(true)
})

it("ending every session is judged like a password change, and either one ends it (SCRUM-603)", () => {
  const ended = { ...live, sessions_revoked_at: new Date(CHANGED) }
  expect(isRevoked({ sub: "u1", signedInAt: CHANGED }, ended)).toBe(true)
  expect(isRevoked({ sub: "u1", signedInAt: CHANGED + 1 }, ended)).toBe(false)
  expect(isRevoked({ sub: "u1", iat: CHANGED / 1000 }, ended)).toBe(true)
  // The later of the two decides, whichever it is.
  const both = { ...live, password_changed_at: new Date(CHANGED - 60_000), sessions_revoked_at: new Date(CHANGED) }
  expect(isRevoked({ sub: "u1", signedInAt: CHANGED - 1 }, both)).toBe(true)
  expect(isRevoked({ sub: "u1", signedInAt: CHANGED - 1 }, { ...both, password_changed_at: new Date(CHANGED), sessions_revoked_at: new Date(CHANGED - 60_000) })).toBe(true)
  expect(isRevoked({ sub: "u1", signedInAt: CHANGED + 1 }, both)).toBe(false)
})

describe("an admin's session ends 12 hours after it proved the password; nobody else's does (SCRUM-1238)", () => {
  const HOUR = 3_600_000
  const DAY = 24 * HOUR
  const admin = { ...live, role: "app_admin" as const }
  const ago = (ms: number) => ({ sub: "u1", signedInAt: Date.now() - ms })

  it("ends an admin proven 12 h and a minute ago, and keeps one proven 11 h ago", () => {
    expect(isRevoked(ago(12 * HOUR + 60_000), admin)).toBe(true)
    expect(isRevoked(ago(11 * HOUR), admin)).toBe(false)
    // A session from before signedInAt existed is judged by its first iat, the same way.
    expect(isRevoked({ sub: "u1", iat: Math.floor((Date.now() - 13 * HOUR) / 1000) }, admin)).toBe(true)
  })

  it.each(["organizer", "venue_owner", "sponsor", "attendee"] as const)("never ends a %s's session for its age", (role) => {
    for (const age of [13 * HOUR, 3 * DAY, 29 * DAY]) expect(isRevoked(ago(age), { ...live, role })).toBe(false)
  })

  it("keeps a non-admin session minted before this change, which carries no new field", () => {
    const minted = { sub: "u1", role: "organizer", signedInAt: Date.now() - 29 * DAY, inviteOnly: false }
    expect(isRevoked(minted, { ...live, role: "organizer" })).toBe(false)
    const legacy = { sub: "u1", role: "venue_owner", iat: Math.floor((Date.now() - 3 * DAY) / 1000) }
    expect(isRevoked(legacy, { ...live, role: "venue_owner" })).toBe(false)
  })

  it("ends a session whose read forgot the role, since it cannot say whether the 12 hours apply", () => {
    const unselected = Object.fromEntries(Object.entries(live).filter(([key]) => key !== "role"))
    expect(isRevoked(ago(60_000), unselected as unknown as typeof live)).toBe(true)
  })
})
