jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/db", () => ({ db: {} }))

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
  const io = {
    to: (room: string) => ({ emit: (event: string) => calls.push(`emit ${event} → ${room}`) }),
    in: (room: string) => ({ socketsLeave: (left: string) => calls.push(`leave ${left} ← ${room}`) }),
  }
  globalThis.__blendnSocketIo = io as never
  return calls
}

afterEach(() => {
  globalThis.__blendnSocketIo = undefined
})

it("tells the room, then removes every socket the banned person holds from it", () => {
  const calls = fakeIo()
  emitChatMemberBanned("room_1", "user_banned", true)
  expect(calls).toEqual([
    "emit chat:memberBanned → chat:room_1",
    // `user:<id>` reaches their sockets on every instance through the adapter.
    "leave chat:room_1 ← user:user_banned",
  ])
})

it("removes nobody on an unban", () => {
  const calls = fakeIo()
  emitChatMemberBanned("room_1", "user_banned", false)
  expect(calls).toEqual(["emit chat:memberBanned → chat:room_1"])
})
