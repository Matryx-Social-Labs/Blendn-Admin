/*
 * Who a room says sent a message (SCRUM-307).
 *
 * The room's own voice — an announcement or a poll — is named after the
 * organisation even when the staff member who sent it is also in the room under
 * a pseudonym; a sponsored poll is "Sponsored", never the organiser. Decided by
 * `type`, which a client cannot set; `metadata`, which it can, is read only on a
 * poll, whose metadata only `createPoll` writes.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
import { roomSenderName } from "@/lib/broadcast-author"

const EVENT = { organizer_org: { display_name: "Nightshift Collective" } }

it("names the room's own voice after the organisation, pseudonym or not", () => {
  expect(roomSenderName({ type: "announcement" }, undefined, EVENT)).toBe("Nightshift Collective")
  expect(roomSenderName({ type: "poll", metadata: { poll: true, kind: "announcement" } }, "Quiet Heron", EVENT)).toBe("Nightshift Collective")
})

it("names a sponsored poll Sponsored, not the organiser", () => {
  expect(roomSenderName({ type: "poll", metadata: { poll: true, kind: "sponsored" } }, undefined, EVENT)).toBe("Sponsored")
})

it("names an attendee by their pseudonym, whatever they put in metadata", () => {
  expect(roomSenderName({ type: "text", metadata: { kind: "sponsored" } }, "Quiet Heron", EVENT)).toBe("Quiet Heron")
  expect(roomSenderName({ type: "text" }, undefined, EVENT)).toBe("Attendee")
})
