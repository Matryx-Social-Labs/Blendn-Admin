process.env.NEXTAUTH_SECRET = "ban-leaves-the-socket-room-secret-32ch"
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/db", () => ({
  db: { chat_groups: { findUnique: async () => ({ event_id: "e0000000-0000-4000-8000-000000000001" }) } },
}))

import { emitChatMemberBanned } from "@/lib/socket-server"

/*
 * A ban takes the person's live sockets out of the room (SCRUM-205, found by
 * the security pass on the read fix). `canJoinChat` refused a banned *rejoin*,
 * and the HTTP reads now refuse too — but a socket already in `chat:<room>`
 * kept receiving every message until it happened to disconnect, so a ban
 * mid-evening stopped their posts and left them reading along.
 */
function fakeIo() {
  const calls: string[] = []
  // The notice is per recipient now (SCRUM-371): fetched, then one emit each.
  const member = (userId: string) => ({
    id: `sock-${userId}`,
    data: { userId },
    emit: (event: string) => calls.push(`emit ${event} → ${userId}`),
  })
  const io = {
    in: (room: string) => ({
      fetchSockets: async () => [member("user_banned"), member("user_other")],
      socketsLeave: (left: string) => calls.push(`leave ${left} ← ${room}`),
    }),
  }
  globalThis.__blendnSocketIo = io as never
  return calls
}

const settle = () => new Promise((r) => setTimeout(r, 10))

afterEach(() => {
  globalThis.__blendnSocketIo = undefined
})

it("tells the room, then removes every socket the banned person holds from it", async () => {
  const calls = fakeIo()
  emitChatMemberBanned("room_1", "user_banned", true)
  await settle()
  expect(calls).toEqual([
    "emit chat:memberBanned → user_banned",
    "emit chat:memberBanned → user_other",
    // `user:<id>` reaches their sockets on every instance through the adapter.
    "leave chat:room_1 ← user:user_banned",
  ])
})

it("removes nobody on an unban", async () => {
  const calls = fakeIo()
  emitChatMemberBanned("room_1", "user_banned", false)
  await settle()
  expect(calls).toEqual(["emit chat:memberBanned → user_banned", "emit chat:memberBanned → user_other"])
})
