jest.mock("@/lib/db", () => ({ db: {} }))
jest.mock("expo-server-sdk", () => ({ Expo: class {} }))

import { CHANNEL_SET_FLOW9, deliveryFor, type NotificationData } from "@/lib/push-notifications"

type Kind = NotificationData["type"]

/**
 * Every kind the sender emits, as the channel installed builds were sent it
 * before Flow 9. A build without `channel_set` must keep getting exactly this:
 * a push naming a channel that build never created lands in "Miscellaneous".
 */
const LEGACY: Record<Kind, string> = {
  private_message: "messages",
  group_message: "rooms",
  event_checkin: "messages",
  event_update: "events",
  announcement: "events",
  message_request: "messages",
  message_request_response: "messages",
  waitlist_promoted: "events",
  match: "messages",
  reveal_request: "messages",
  reveal: "messages",
  board_request: "messages",
  board_request_accepted: "messages",
  friend_request: "messages",
  friend_accepted: "messages",
  rating_request: "events",
  crew_invite: "messages",
  crew_here: "messages",
  blend: "messages",
  venue_offer: "offers",
  // New: filed with the event's other changes.
  event_changed: "events",
  report_actioned: "messages",
}

/** Flow 9: each kind on one of the channels people see in settings, or `default`. */
const FLOW9: Record<Kind, string> = {
  ...LEGACY,
  event_checkin: "default",
  match: "people",
  reveal_request: "people",
  reveal: "people",
  friend_request: "people",
  friend_accepted: "people",
  crew_invite: "crew",
  crew_here: "crew",
  blend: "crew",
  rating_request: "later",
  report_actioned: "default",
}

const data = (type: Kind): NotificationData => ({ type, eventId: "e1", conversationId: "c1", chatGroupId: "g1" })

describe("the Android channel of every kind", () => {
  it.each(Object.keys(LEGACY) as Kind[])("%s: a build before Flow 9 is sent what it always was", (type) => {
    expect(deliveryFor(data(type)).channelId).toBe(LEGACY[type])
    expect(deliveryFor(data(type), null).channelId).toBe(LEGACY[type])
    expect(deliveryFor(data(type), 1).channelId).toBe(LEGACY[type])
  })

  it.each(Object.keys(FLOW9) as Kind[])("%s: a Flow 9 build gets its own", (type) => {
    expect(deliveryFor(data(type), CHANNEL_SET_FLOW9).channelId).toBe(FLOW9[type])
  })

  it("a payload with no type is `default` for every build", () => {
    expect(deliveryFor(undefined).channelId).toBe("default")
    expect(deliveryFor(undefined, CHANNEL_SET_FLOW9).channelId).toBe("default")
  })

  it("the replace-in-place keys are the same for both: a conversation or an event is one notification", () => {
    expect(deliveryFor(data("private_message"), CHANNEL_SET_FLOW9)).toMatchObject({ collapseId: "dm:c1", tag: "dm:c1" })
    expect(deliveryFor(data("event_changed"), CHANNEL_SET_FLOW9)).toMatchObject({ collapseId: "event:e1" })
    expect(deliveryFor(data("event_changed"))).toEqual(deliveryFor(data("event_update")))
    expect(deliveryFor(data("rating_request"), CHANNEL_SET_FLOW9)).toMatchObject({ channelId: "later", collapseId: "rate:e1" })
  })

  it("the four channels a Flow 9 build adds are the only new names", () => {
    const named = new Set(Object.values(FLOW9))
    expect([...named].sort()).toEqual(["crew", "default", "events", "later", "messages", "offers", "people", "rooms"])
  })
})
