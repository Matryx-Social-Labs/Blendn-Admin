/*
 * A stamp locks the account (SCRUM-1169, D-026, D-027), wherever it was
 * written: the stamp comes from `scripts/under-18-accounts.ts`, a process of
 * its own, so only the database tells the server. A socket opened before the
 * stamp is closed at the server's next blocklist read (lib/account-blocklist.ts),
 * its reconnect is refused at the handshake, and a staff correction lets the
 * account straight back in.
 *
 * A real socket.io server with the app's handshake (`initSocketServer`), real
 * rows, the real refresh route.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
import { createServer } from "http"
import type { AddressInfo } from "net"
import { NextRequest } from "next/server"
import { io as connect, type Socket as ClientSocket } from "socket.io-client"

import { recentlyBlocked } from "@/lib/account-blocklist"
import { signAccessToken, signRefreshToken, storeRefreshToken } from "@/lib/mobile-auth"
import { resetMemoryStore } from "@/lib/rate-limit-store"
import { initSocketServer } from "@/lib/socket-server"
import { stopSponsoredScheduler } from "@/lib/sponsored-scheduler"
import { correctBirthDate, stampKnownMinors } from "@/scripts/under-18-accounts"

import { closeDb, db, makeUser, testId } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const refreshRoute = require("@/app/api/mobile/auth/refresh/route") as typeof import("@/app/api/mobile/auth/refresh/route")

const users: string[] = []
const httpServer = createServer()
const io = initSocketServer(httpServer)
const sockets: ClientSocket[] = []
let ADMIN = ""

beforeAll(async () => {
  await new Promise<void>((resolve) => httpServer.listen(0, resolve))
  const adminId = await makeUser(testId("u18lock-admin"), "app_admin")
  users.push(adminId)
  ADMIN = `${adminId}@matrixsociallabs.com`
  await db.user.update({ where: { id: adminId }, data: { email: ADMIN } })
})

afterAll(async () => {
  for (const socket of sockets) socket.close()
  stopSponsoredScheduler()
  globalThis.__blendnSocketIo = null
  await new Promise<void>((resolve) => io.close(() => resolve()))
  await db.audit_logs.deleteMany({ where: { OR: [{ resource_id: { in: users } }, { user_id: { in: users } }] } })
  await db.mobile_refresh_tokens.deleteMany({ where: { user_id: { in: users } } })
  await db.profiles.deleteMany({ where: { id: { in: users } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

beforeEach(() => resetMemoryStore())

async function person(label: string, age: number) {
  const id = await makeUser(testId(label))
  users.push(id)
  await db.profiles.create({ data: { id, name: label, onboarded: true, age } })
  const { email } = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  return { id, email }
}

type Handshake = { connected: true; socket: ClientSocket; closed: string[] } | { message: string; code?: string }
function handshake(userId: string, email: string): Promise<Handshake> {
  const { port } = httpServer.address() as AddressInfo
  const socket = connect(`http://localhost:${port}`, {
    auth: { token: signAccessToken(userId, email) },
    transports: ["websocket"],
    reconnection: false,
  })
  sockets.push(socket)
  const closed: string[] = []
  socket.on("disconnect", (reason) => closed.push(reason))
  return new Promise((resolve) => {
    socket.on("connect", () => resolve({ connected: true, socket, closed }))
    socket.on("connect_error", (error) =>
      resolve({ message: error.message, code: (error as Error & { data?: { code?: string } }).data?.code })
    )
  })
}

/** One read of the blocked-accounts set, as the server's next request makes it once the set is stale. */
async function blocklistRead() {
  const shared = globalThis as typeof globalThis & { __blendnBlocklist?: { fetchedAt: number } }
  if (shared.__blendnBlocklist) shared.__blendnBlocklist.fetchedAt = 0
  await recentlyBlocked("nobody", Math.floor(Date.now() / 1000))
}

async function until(done: () => boolean, ms = 3000) {
  for (let waited = 0; !done() && waited < ms; waited += 50) await new Promise((r) => setTimeout(r, 50))
}

async function refresh(id: string, email: string) {
  const token = signRefreshToken(id, email)
  await storeRefreshToken(id, token)
  return refreshRoute.POST(
    new NextRequest("http://localhost/api/mobile/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "10.18.0.1" },
      body: JSON.stringify({ refreshToken: token }),
    })
  )
}

it("closes a socket opened before the stamp at the next blocklist read, refuses its reconnect, and leaves everyone else connected", async () => {
  const minor = await person("u18lock-minor", 16)
  const adult = await person("u18lock-adult", 30)
  await blocklistRead()
  const before = await handshake(minor.id, minor.email)
  const bystander = await handshake(adult.id, adult.email)
  if (!("connected" in before) || !("connected" in bystander)) throw new Error("both should connect before the stamp")

  // The script, in its own process: only the row changes.
  expect(await stampKnownMinors(db, new Date())).toContain(minor.id)
  expect(before.socket.connected).toBe(true)

  await blocklistRead()
  await until(() => before.closed.length > 0)
  expect(before.closed).toEqual(["io server disconnect"])
  expect(bystander.socket.connected).toBe(true)
  expect(bystander.closed).toEqual([])

  expect(await handshake(minor.id, minor.email)).toEqual({ message: "Authentication required", code: "AGE_RESTRICTED" })
  expect(await recentlyBlocked(minor.id, Math.floor(Date.now() / 1000))).toBe(true)
})

it("a staff correction unlocks at once: the refresh succeeds, the next blocklist read drops the id, the socket connects", async () => {
  const minor = await person("u18lock-corrected", 16)
  await stampKnownMinors(db, new Date())
  await blocklistRead()
  expect((await refresh(minor.id, minor.email)).status).toBe(403)
  expect(await recentlyBlocked(minor.id, Math.floor(Date.now() / 1000))).toBe(true)

  await correctBirthDate(db, { userId: minor.id, dateOfBirth: "1995-06-15", by: ADMIN }, new Date())

  expect((await refresh(minor.id, minor.email)).status).toBe(200)
  await blocklistRead()
  expect(await recentlyBlocked(minor.id, Math.floor(Date.now() / 1000))).toBe(false)
  expect(await handshake(minor.id, minor.email)).toMatchObject({ connected: true })
})
