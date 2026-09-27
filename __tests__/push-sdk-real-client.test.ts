/**
 * The real expo-server-sdk, unmocked.
 *
 * Every other push test replaces `expo-server-sdk` with a hand-written stub,
 * so a major version that changed what counts as a push token, or how
 * messages are batched, would pass all of them. lib/push-notifications.ts
 * leans on exactly these two behaviours: it drops anything
 * `Expo.isExpoPushToken` refuses, and it sends whatever
 * `chunkPushNotifications` hands back, one request per chunk.
 *
 * Nothing here touches the network — both are pure functions of the client.
 */
import { Expo, type ExpoPushMessage } from "expo-server-sdk"

describe("expo-server-sdk (real client)", () => {
  it("accepts the token shapes the app registers and refuses anything else", () => {
    expect(Expo.isExpoPushToken("ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]")).toBe(true)
    expect(Expo.isExpoPushToken("ExpoPushToken[xxxxxxxxxxxxxxxxxxxxxx]")).toBe(true)
    expect(Expo.isExpoPushToken("not-a-token")).toBe(false)
    expect(Expo.isExpoPushToken("")).toBe(false)
  })

  it("batches 150 messages into two requests, the service's 100-per-request limit", () => {
    const message: ExpoPushMessage = { to: "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]", body: "hi" }
    const chunks = new Expo().chunkPushNotifications(Array(150).fill(message))

    expect(chunks.map((c) => c.length)).toEqual([100, 50])
  })
})
