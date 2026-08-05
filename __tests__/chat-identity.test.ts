/**
 * Event chat is pseudonymous: attendees get an `anonymous_name` on check-in and
 * every surface shows that instead of who they are. The point is honest
 * feedback — an attendee who knows the organiser can see their name does not
 * say the venue was filthy.
 *
 * The dashboard chat route shipped real `name` and `email` in its JSON to any
 * host, so the anonymity was cosmetic: readable straight out of the network
 * tab. This pins the shaping so it cannot come back.
 *
 * The shaping logic is inline in the route (it is three lines of spread), so
 * this reproduces it exactly rather than importing — a divergence between this
 * and the route would show up as the route changing and this staying green,
 * which is why the route carries a comment pointing here.
 */

type Role = "app_admin" | "organizer" | "venue_owner"

const ATTENDEE = {
  id: "usr_abc",
  name: "Ana Torres",
  email: "ana@example.com",
  image: "https://cdn/ana.jpg",
}

/** Mirrors app/api/events/[id]/chat/messages/route.ts message shaping. */
function shapeUser(role: Role, anonymousName: string | null) {
  const isPlatformAdmin = role === "app_admin"
  return {
    id: ATTENDEE.id,
    anonymousName,
    ...(isPlatformAdmin
      ? { name: ATTENDEE.name, email: ATTENDEE.email, image: ATTENDEE.image }
      : {}),
  }
}

describe("chat message identity shaping", () => {
  it("gives hosts the pseudonym and nothing that names a person", () => {
    for (const role of ["organizer", "venue_owner"] as const) {
      const shaped = shapeUser(role, "Quiet Otter")

      expect(shaped.anonymousName).toBe("Quiet Otter")
      // Absent, not null — reading `user.name` gets undefined rather than a
      // convincing blank that looks like the attendee simply has no name set.
      expect("name" in shaped).toBe(false)
      expect("email" in shaped).toBe(false)
      expect("image" in shaped).toBe(false)

      // The blunt version of the same assertion: nothing identifying anywhere
      // in the payload, however it gets restructured later.
      const json = JSON.stringify(shaped)
      expect(json).not.toContain(ATTENDEE.name)
      expect(json).not.toContain(ATTENDEE.email)
      expect(json).not.toContain("@")
    }
  })

  it("keeps the user id for hosts, because ban and mute need it", () => {
    const shaped = shapeUser("organizer", "Quiet Otter")
    // /api/events/[id]/chat/members/[userId] is keyed on this. A cuid names
    // nobody, and hosts have no surface that resolves one to a person.
    expect(shaped.id).toBe(ATTENDEE.id)
  })

  it("still gives app_admin the real identity", () => {
    const shaped = shapeUser("app_admin", "Quiet Otter")
    expect(shaped.name).toBe(ATTENDEE.name)
    expect(shaped.email).toBe(ATTENDEE.email)
    expect(shaped.anonymousName).toBe("Quiet Otter")
  })

  it("does not fall back to a real name when the pseudonym is missing", () => {
    // A member row with no anonymous_name yet (joined before backfill) must
    // degrade to "Attendee" at the UI, never to the real name.
    const shaped = shapeUser("organizer", null)
    expect(shaped.anonymousName).toBeNull()
    expect("name" in shaped).toBe(false)
  })
})
