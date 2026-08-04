import {
  canAccessDashboard,
  canManageEvent,
  canModerateChat,
  canSendSystemMessages,
  canSendPushNotifications,
} from "@/lib/rbac"

const OWNER = "user_owner"
const STRANGER = "user_stranger"

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

describe("canManageEvent", () => {
  it("lets app_admin manage any event", () => {
    expect(canManageEvent("app_admin", STRANGER, OWNER)).toBe(true)
  })

  it("scopes organizers to events they own", () => {
    expect(canManageEvent("organizer", OWNER, OWNER)).toBe(true)
    expect(canManageEvent("organizer", STRANGER, OWNER)).toBe(false)
  })

  it("denies venue_owner and attendee outright", () => {
    expect(canManageEvent("venue_owner", OWNER, OWNER)).toBe(false)
    expect(canManageEvent("attendee", OWNER, OWNER)).toBe(false)
  })
})

describe("canModerateChat", () => {
  it("lets app_admin moderate any chat", () => {
    expect(canModerateChat("app_admin", STRANGER, OWNER)).toBe(true)
  })

  it("scopes organizers and venue owners to their own events", () => {
    expect(canModerateChat("organizer", OWNER, OWNER)).toBe(true)
    expect(canModerateChat("organizer", STRANGER, OWNER)).toBe(false)
    expect(canModerateChat("venue_owner", OWNER, OWNER)).toBe(true)
    expect(canModerateChat("venue_owner", STRANGER, OWNER)).toBe(false)
  })

  it("denies attendees", () => {
    expect(canModerateChat("attendee", OWNER, OWNER)).toBe(false)
  })

  it("differs from canManageEvent: venue_owner may moderate but not manage", () => {
    expect(canModerateChat("venue_owner", OWNER, OWNER)).toBe(true)
    expect(canManageEvent("venue_owner", OWNER, OWNER)).toBe(false)
  })
})

describe("admin-only capabilities", () => {
  it("restricts system messages and push notifications to app_admin", () => {
    for (const role of ["organizer", "venue_owner", "attendee"] as const) {
      expect(canSendSystemMessages(role)).toBe(false)
      expect(canSendPushNotifications(role)).toBe(false)
    }
    expect(canSendSystemMessages("app_admin")).toBe(true)
    expect(canSendPushNotifications("app_admin")).toBe(true)
  })
})
