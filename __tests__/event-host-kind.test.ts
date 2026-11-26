import { eventHost, hostPayload } from "@/lib/event-host"

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

/**
 * What the app is sent as `organizer` (SCRUM-1146): the organisation, never the creating user. `organizer_id` is who
 * made the row (for a curated event, the admin who ran the curation); no branch may carry their id, name or image.
 */
describe("hostPayload", () => {
  const creator = { id: "user-1", name: "Admin Person", image: "https://cdn/a.jpg" }

  it("an org event names the org by its id", () => {
    expect(hostPayload({ kind: "event", organizer_org_id: "org-1", organizer_org: { display_name: "Bangalore Startups" }, organizer: creator })).toEqual({
      id: "org-1",
      name: "Bangalore Startups",
      image: null,
      kind: "org",
    })
  })

  it("a curated event is the platform, with no id", () => {
    expect(hostPayload({ kind: "event", curated_at: new Date(), organizer_org_id: null, organizer_org: null, organizer: creator })).toEqual({ id: null, name: "Blendn", image: null, kind: "platform" })
  })

  it("a venue day is the venue, with no id", () => {
    expect(hostPayload({ kind: "venue_day", venue_name: "The Humming Tree", organizer_org_id: null, organizer_org: null, organizer: creator })).toEqual({
      id: null,
      name: "The Humming Tree",
      image: null,
      kind: "venue",
    })
  })

  it("an org with no public name yet sends neither the org id nor the creator", () => {
    expect(hostPayload({ kind: "event", organizer_org_id: "org-1", organizer_org: { display_name: "  " }, organizer: creator })).toEqual({ id: null, name: null, image: null, kind: "person" })
  })

  it("a person's own event carries nothing of the person", () => {
    expect(hostPayload({ kind: "event", organizer_org_id: null, organizer_org: null, organizer: creator })).toEqual({ id: null, name: null, image: null, kind: "person" })
  })
})
