import { eventHost } from "@/lib/event-host"

/**
 * Room info's Host row is org-only (Flow 5 C6, SCRUM-1095): `kind` says what the host name is, so the app never
 * labels a person, the platform or a venue as an event's Host. Each case next to the one it could be mistaken for.
 */
describe("eventHost kind", () => {
  it("an organisation is org", () => {
    expect(eventHost({ organizer_org: { display_name: "Bangalore Startups" }, organizer: { name: "Asha" } })).toEqual({ name: "Bangalore Startups", isPlatform: false, kind: "org" })
  })

  it("an event with no org names its creating user as a person, never an org", () => {
    expect(eventHost({ organizer_org: null, organizer: { name: "Asha Rao" } })).toEqual({ name: "Asha Rao", isPlatform: false, kind: "person" })
  })

  it("a blank org name falls through to the person", () => {
    expect(eventHost({ organizer_org: { display_name: "  " }, organizer: { name: "Asha" } }).kind).toBe("person")
  })

  it("a curated event nobody claimed is the platform, even with a creating user", () => {
    expect(eventHost({ curated_at: new Date(), organizer: { name: "Admin Person" } })).toEqual({ name: "Blendn", isPlatform: true, kind: "platform" })
  })

  it("a venue day is the venue", () => {
    expect(eventHost({ kind: "venue_day", venue_name: "The Humming Tree" })).toEqual({ name: "The Humming Tree", isPlatform: true, kind: "venue" })
  })

  it("nobody at all is the platform", () => {
    expect(eventHost({}).kind).toBe("platform")
  })
})
