import { NextRequest } from "next/server"

/*
 * Deleting an account closes the sockets it already had open (SCRUM-449).
 *
 * Driven on staging (SCRUM-273): a fixture opened a socket, then deleted its
 * account through `DELETE /api/mobile/account`. A new handshake with the same
 * token was refused, and REST answered 401, but the socket that was already
 * open was still connected 3 s later. Suspension severs live connections
 * (`evictUserSockets`); deletion did not. So a second phone signed in to the
 * deleted account went on receiving its rooms and DMs until it dropped.
 *
 * A real socket.io server, installed as the app's `io`, with each client's
 * server-side socket in `user:<id>` and a room, as the connection handler puts
 * it. The delete goes through the real route, on real rows.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/tigris", () => ({ deletePrefix: jest.fn().mockResolvedValue(0) }))
import { createServer } from "http"
import type { AddressInfo } from "net"
import { Server } from "socket.io"
import { io as connect, type Socket as ClientSocket } from "socket.io-client"
import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeUser, onboard, testId } from "./helpers"
// eslint-disable-next-line @typescript-eslint/no-require-imports
const accountRoute = require("@/app/api/mobile/account/route") as typeof import("@/app/api/mobile/account/route")

const users: string[] = []
const httpServer = createServer()
const io = new Server(httpServer)
const clients: ClientSocket[] = []

io.on("connection", (socket) => {
  const userId = String(socket.handshake.auth.userId)
  socket.data.userId = userId
  socket.join([`user:${userId}`, "chat:dev-shared-room"])
})

async function open(userId: string) {
  const { port } = httpServer.address() as AddressInfo
  const socket = connect(`http://localhost:${port}`, { auth: { userId }, transports: ["websocket"], reconnection: false })
  clients.push(socket)
  const closed: string[] = []
  socket.on("disconnect", (reason) => closed.push(reason))
  await new Promise<void>((resolve) => socket.on("connect", () => resolve()))
  return { socket, closed }
}

beforeAll(async () => {
  await new Promise<void>((resolve) => httpServer.listen(0, resolve))
  globalThis.__blendnSocketIo = io as typeof globalThis.__blendnSocketIo
})

afterAll(async () => {
  for (const c of clients) c.close()
  await new Promise<void>((resolve) => io.close(() => resolve()))
  globalThis.__blendnSocketIo = null
  await db.profiles.deleteMany({ where: { id: { in: users } } })
  await cleanup(users, [])
  await closeDb()
})

it("closes every socket the deleted account had open, and nobody else's", async () => {
  const leaver = await makeUser(testId("des-leaver"))
  const bystander = await makeUser(testId("des-bystander"))
  users.push(leaver, bystander)
  await onboard(leaver, bystander)
  const { email } = await db.user.findUniqueOrThrow({ where: { id: leaver }, select: { email: true } })

  // Two phones signed in to the account that is about to go, and someone else.
  const phoneA = await open(leaver)
  const phoneB = await open(leaver)
  const other = await open(bystander)

  const res = await accountRoute.DELETE(
    new NextRequest("http://localhost/api/mobile/account", {
      method: "DELETE",
      headers: { "content-type": "application/json", authorization: `Bearer ${signAccessToken(leaver, email)}` },
    })
  )
  expect(res.status).toBe(200)
  await new Promise((r) => setTimeout(r, 300))

  expect(phoneA.closed).toEqual(["io server disconnect"])
  expect(phoneB.closed).toEqual(["io server disconnect"])
  expect(phoneB.socket.connected).toBe(false)
  expect(other.closed).toEqual([])
  expect(other.socket.connected).toBe(true)
})
