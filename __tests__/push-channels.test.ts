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
  match: "matches",
  reveal_request: "matches",
  reveal: "matches",
  friend_request: "matches",
  friend_accepted: "matches",
  board_request: "matches",
  board_request_accepted: "matches",
  crew_invite: "crew",
  crew_here: "crew",
  blend: "crew",
  rating_request: "after-the-night",
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
    expect(deliveryFor(data("rating_request"), CHANNEL_SET_FLOW9)).toMatchObject({ channelId: "after-the-night", collapseId: "rate:e1" })
  })

  it("the three channels a Flow 9 build adds are the only new names, and offers stays", () => {
    const named = new Set(Object.values(FLOW9))
    expect([...named].sort()).toEqual(["after-the-night", "crew", "default", "events", "matches", "messages", "offers", "rooms"])
    expect(FLOW9.venue_offer).toBe("offers")
    expect(deliveryFor(data("venue_offer"), CHANNEL_SET_FLOW9).channelId).toBe("offers")
  })
})

/**
 * origin/dev's `deliveryFor`, in full, for every kind it knew, evaluated at
 * `{ conversationId: "c1", chatGroupId: "g1", eventId: "e1" }` before this
 * branch touched it (generated from the old function, not typed from memory).
 * A build that does not say `channelSet` must be sent exactly this: the id, the
 * thread and the replace keys.
 */
const BEFORE = {
  private_message: { channelId: "messages", threadId: "dm:c1", collapseId: "dm:c1", tag: "dm:c1" },
  group_message: { channelId: "rooms", threadId: "room:g1", collapseId: "room:g1", tag: "room:g1" },
  event_checkin: { channelId: "messages" },
  event_update: { channelId: "events", threadId: "event:e1", collapseId: "event:e1", tag: "event:e1" },
  announcement: { channelId: "events", threadId: "event:e1" },
  message_request: { channelId: "messages" },
  message_request_response: { channelId: "messages" },
  waitlist_promoted: { channelId: "events", threadId: "event:e1" },
  match: { channelId: "messages" },
  reveal_request: { channelId: "messages" },
  reveal: { channelId: "messages" },
  board_request: { channelId: "messages" },
  board_request_accepted: { channelId: "messages" },
  friend_request: { channelId: "messages" },
  friend_accepted: { channelId: "messages" },
  rating_request: { channelId: "events", threadId: "rate:e1", collapseId: "rate:e1", tag: "rate:e1" },
  crew_invite: { channelId: "messages" },
  crew_here: { channelId: "messages" },
  blend: { channelId: "messages" },
  venue_offer: { channelId: "offers" },
} as const
const NEW_KINDS_BEFORE = {
  // Kinds that did not exist: filed with their nearest neighbour, and `messages` for the one with none.
  event_changed: BEFORE.event_update,
  report_actioned: { channelId: "messages" },
} as const

describe("a build that does not say channelSet is sent exactly what origin/dev sent", () => {
  const all = { ...BEFORE, ...NEW_KINDS_BEFORE }
  it.each(Object.keys(all) as Array<keyof typeof all>)("%s: the whole object, not only the channel id", (type) => {
    expect(deliveryFor(data(type), null)).toEqual(all[type])
    expect(deliveryFor(data(type))).toEqual(all[type])
    expect(deliveryFor(data(type), 1)).toEqual(all[type])
  })

  it("with no ids to key on, the keys are left off and only the channel remains", () => {
    for (const [type, channelId] of [["announcement", "events"], ["waitlist_promoted", "events"], ["private_message", "messages"], ["group_message", "rooms"], ["event_update", "events"], ["rating_request", "events"]] as const) {
      expect(deliveryFor({ type }, null)).toEqual({ channelId })
    }
    expect(deliveryFor(undefined, null)).toEqual({ channelId: "default" })
  })
})

describe("a Flow 9 build: the delivery keys travel with the new channel ids", () => {
  const V = CHANNEL_SET_FLOW9
  it("an announcement and a waitlist promotion stack with their event, replacing nothing", () => {
    expect(deliveryFor(data("announcement"), V)).toEqual({ channelId: "events", threadId: "event:e1" })
    expect(deliveryFor(data("waitlist_promoted"), V)).toEqual({ channelId: "events", threadId: "event:e1" })
  })

  it("a room reply is one notification per room, on rooms", () => {
    expect(deliveryFor(data("group_message"), V)).toEqual({ channelId: "rooms", threadId: "room:g1", collapseId: "room:g1", tag: "room:g1" })
  })

  it("a DM replaces in place on messages; a message request has no keys at all", () => {
    expect(deliveryFor(data("private_message"), V)).toEqual({ channelId: "messages", threadId: "dm:c1", collapseId: "dm:c1", tag: "dm:c1" })
    expect(deliveryFor(data("message_request"), V)).toEqual({ channelId: "messages" })
  })

  it("an event's change replaces in place; so does the rating, now on its own channel; an offer is just offers", () => {
    expect(deliveryFor(data("event_changed"), V)).toEqual(BEFORE.event_update)
    expect(deliveryFor(data("rating_request"), V)).toEqual({ channelId: "after-the-night", threadId: "rate:e1", collapseId: "rate:e1", tag: "rate:e1" })
    expect(deliveryFor(data("venue_offer"), V)).toEqual({ channelId: "offers" })
  })

  it("the new channels carry no replace keys of their own", () => {
    for (const type of ["match", "friend_request", "board_request", "crew_invite", "crew_here", "blend"] as const) {
      const { channelId, ...keys } = deliveryFor(data(type), V)
      expect(["matches", "crew"]).toContain(channelId)
      expect(keys).toEqual({})
    }
  })
})
