const mockTokens = jest.fn().mockResolvedValue([])
jest.mock("@/lib/db", () => ({ db: { push_tokens: { findMany: (...a: unknown[]) => mockTokens(...a) } } }))
jest.mock("expo-server-sdk", () => ({ Expo: class {} }))

import { notifyLobbyMatch } from "@/lib/push-notifications"

/*
 * "Someone offers what you're looking for" is one push per person per event
 * per half hour (SCRUM-1026 security review): an offerer posting ten offers
 * must not ring a seeker ten times. No device is registered here, so `failed`
 * counts the people the throttle let through.
 */
const event = { id: "e-1", title: "Kerala Design Week" }

it("lets each person through once per event in the window", async () => {
  expect(await notifyLobbyMatch(["a", "b"], event, "p1", "ride")).toEqual({ sent: 0, failed: 2 })
  expect(await notifyLobbyMatch(["a", "b", "c"], event, "p2", "ride")).toEqual({ sent: 0, failed: 1 })
  expect(await notifyLobbyMatch(["a"], { ...event, id: "e-2" }, "p3", "ride")).toEqual({ sent: 0, failed: 1 })
})

it("asks for devices behind the event's switch", async () => {
  await notifyLobbyMatch(["z"], { id: "e-9", title: "x" }, "p9", "spots")
  const where = mockTokens.mock.calls.at(-1)[0].where
  expect(JSON.stringify(where)).toContain('"offers_match":true')
  expect(JSON.stringify(where)).toContain('"event_id":"e-9"')
})
