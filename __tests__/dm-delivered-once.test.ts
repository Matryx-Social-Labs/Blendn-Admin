/*
 * A DM reaches each of the recipient's sockets once (SCRUM-337).
 *
 * Driven on staging (SCRUM-268): the recipient's socket, in the conversation
 * room because the chat was open, received `private:message` twice with the
 * same id — `emitPrivateMessage` emitted to `conversation:<id>` and then to
 * `user:<recipient>`, and every socket is in its own user room. The open chat
 * de-duplicates by id; the chat list adds one to the unread count per event,
 * so it counted each message twice.
 *
 * A real socket.io server installed as the app's `io`, and real clients:
 * the recipient with the chat open (both rooms), the recipient on the list
 * (user room only), and the sender with the chat open.
 */
jest.mock("@/lib/db", () => ({ db: {} }))
jest.mock("@/lib/mobile-auth", () => ({ verifyAccessToken: jest.fn(), accountBlockReason: jest.fn() }))
import { createServer } from "http"
import type { AddressInfo } from "net"
import { Server } from "socket.io"
import { io as connect, type Socket as ClientSocket } from "socket.io-client"
import { emitPrivateMessage } from "@/lib/socket-server"

const CONVO = "c0000000-0000-4000-8000-000000000337"
const SENDER = "sender"
const RECIPIENT = "recipient"

const httpServer = createServer()
const io = new Server(httpServer)
const clients: ClientSocket[] = []

io.on("connection", (socket) => {
  const { userId, rooms } = socket.handshake.auth as { userId: string; rooms: string[] }
  socket.join([`user:${userId}`, ...rooms])
})

async function listen(userId: string, rooms: string[]): Promise<string[]> {
  const { port } = httpServer.address() as AddressInfo
  const socket = connect(`http://localhost:${port}`, { auth: { userId, rooms }, transports: ["websocket"] })
  clients.push(socket)
  const ids: string[] = []
  socket.on("private:message", (p: { conversationId: string; message: { id: string } }) => ids.push(`${p.conversationId}/${p.message.id}`))
  await new Promise<void>((resolve) => socket.on("connect", () => resolve()))
  return ids
}

beforeAll(async () => {
  await new Promise<void>((resolve) => httpServer.listen(0, resolve))
  ;(globalThis as { __blendnSocketIo?: unknown }).__blendnSocketIo = io
})

afterAll(async () => {
  for (const c of clients) c.close()
  ;(globalThis as { __blendnSocketIo?: unknown }).__blendnSocketIo = null
  await new Promise<void>((resolve) => io.close(() => resolve()))
})

it("reaches each socket once: the open chat, the chat list, the sender's open chat and the sender's other device (SCRUM-446)", async () => {
  const chatOpen = await listen(RECIPIENT, [`conversation:${CONVO}`])
  const onList = await listen(RECIPIENT, [])
  const senderChat = await listen(SENDER, [`conversation:${CONVO}`])
  // The sender's second phone, on the Banter list: in its user room only.
  const senderOtherDevice = await listen(SENDER, [])

  emitPrivateMessage(CONVO, RECIPIENT, {
    id: "m1",
    conversationId: CONVO,
    senderId: SENDER,
    sender: { id: SENDER, name: null, image: null },
    text: "hi",
    mediaUrl: null,
    mediaType: null,
    isRead: false,
    createdAt: new Date(),
  })
  await new Promise((r) => setTimeout(r, 200))

  expect(chatOpen).toEqual([`${CONVO}/m1`])
  expect(onList).toEqual([`${CONVO}/m1`])
  expect(senderChat).toEqual([`${CONVO}/m1`])
  expect(senderOtherDevice).toEqual([`${CONVO}/m1`])
})
