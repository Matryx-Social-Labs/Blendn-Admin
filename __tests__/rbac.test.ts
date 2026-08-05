import {
  canAccessDashboard,
  canSendSystemMessages,
  canSendPushNotifications,
} from "@/lib/rbac"

/**
 * Role-only predicates — the ones that genuinely depend on nothing but the
 * role. Per-event authorization moved to `eventPermissions` and is asserted as
 * a full matrix in __tests__/event-permissions.test.ts.
 *
 * `canManageEvent` and `canModerateChat` used to live here and contradicted
 * each other about venue owners; splitting role-only from relationship-shaped
 * is what made that contradiction impossible to express.
 */

describe("canAccessDashboard", () => {
  it("admits staff roles", () => {
    expect(canAccessDashboard("app_admin")).toBe(true)
    expect(canAccessDashboard("organizer")).toBe(true)
    expect(canAccessDashboard("venue_owner")).toBe(true)
  })

  it("keeps attendees out — they are mobile-only", () => {
    expect(canAccessDashboard("attendee")).toBe(false)
  })
})

describe("admin-only capabilities", () => {
  it("restricts system messages and push notifications to app_admin", () => {
    // These are platform-voice actions: a system message appears as Blend'n
    // itself, and a push lands on every attendee's phone. Neither scopes to
    // ownership, so neither belongs in eventPermissions.
    for (const role of ["organizer", "venue_owner", "attendee"] as const) {
      expect(canSendSystemMessages(role)).toBe(false)
      expect(canSendPushNotifications(role)).toBe(false)
    }
    expect(canSendSystemMessages("app_admin")).toBe(true)
    expect(canSendPushNotifications("app_admin")).toBe(true)
  })
})
