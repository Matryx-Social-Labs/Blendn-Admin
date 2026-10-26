/**
 * Load test: the hot read routes, and one busy event room.
 *
 *   BASE_URL=http://localhost:3200 DATABASE_URL=… MOBILE_JWT_SECRET=… \
 *     npx tsx scripts/load.ts [members=200] [senders=20] [seconds=60] [readers=50]
 *
 * Local only. It writes users, memberships and messages, so it refuses any
 * BASE_URL or DATABASE_URL that is not localhost, and deletes what it wrote.
 *
 * Phase 1, reads: `readers` workers loop over the routes a launch and a room
 * open hit, for `seconds`. Phase 2, chat: `members` sockets join one live event
 * room; `senders` of them each post every 4 s (under the 30/min and 5/10 s
 * limits, with varied text so the duplicate check stays quiet). Reported:
 * POST latency, and fan-out latency (POST start → arrival at each other socket).
 *
 * The server's moderation calls OpenAI only when OPENAI_API_KEY is set; without
 * it, chat numbers exclude the ~300–450 ms moderation floor measured on staging.
 */
import { io, type Socket } from "socket.io-client"
import { db, closeDb, makeUser, onboard } from "../__tests__/integration/helpers"
import { signAccessToken } from "../lib/mobile-auth"
import { realEventsWhere } from "../lib/event-kind"

const BASE = (process.env.BASE_URL ?? "http://localhost:3200").replace(/\/$/, "")
const [MEMBERS, SENDERS, SECONDS, READERS] = [200, 20, 60, 50].map((d, i) => Number(process.argv[2 + i] ?? d))
const SEND_EVERY_MS = 4_000
const isLocal = (url: string) => /^(https?|postgres(ql)?):\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(url)

const READ_ROUTES = [
  "/api/mobile/events?limit=20",
  "/api/mobile/events/cities",
  "/api/mobile/chat/groups",
  "/api/mobile/checkins/active",
  "/api/mobile/notifications?limit=30",
  "/api/mobile/me/plus",
  "/api/mobile/me/rsvps",
  "/api/mobile/conversations",
  "/api/mobile/venues?limit=20",
  "/api/mobile/board/requests",
]
const WORDS = "coffee stage sunset table music window corner later crowd playlist friend bar round seat queue rain light jazz tonight early".split(" ")

const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]
}
const line = (label: string, xs: number[]) =>
  `${label.padEnd(40)} n=${String(xs.length).padStart(6)}  p50=${pct(xs, 0.5).toFixed(0).padStart(5)}  p95=${pct(xs, 0.95).toFixed(0).padStart(5)}  p99=${pct(xs, 0.99).toFixed(0).padStart(5)} ms`

async function liveRoom() {
  const now = new Date()
  const room = await db.chat_groups.findFirst({
    where: { kind: "event", event: { ...realEventsWhere, status: "published", deleted_at: null, start_time: { lte: now }, end_time: { gte: now } } },
    orderBy: { members: { _count: "desc" } },
    select: { id: true },
  })
  if (!room) throw new Error("no live event room — run scripts/seed-blr-scenarios.ts --apply (or --refresh-times)")
  return room
}

async function reads(tokens: string[]) {
  const timings = new Map<string, number[]>(READ_ROUTES.map((r) => [r, []]))
  let errors = 0
  const until = Date.now() + SECONDS * 1000
  await Promise.all(
    Array.from({ length: READERS }, async (_, w) => {
      for (let i = 0; Date.now() < until; i++) {
        const route = READ_ROUTES[(w + i) % READ_ROUTES.length]
        const t = performance.now()
        const r = await fetch(BASE + route, { headers: { authorization: `Bearer ${tokens[w % tokens.length]}` } })
        await r.arrayBuffer()
        if (r.ok) timings.get(route)!.push(performance.now() - t)
        else errors++
      }
    })
  )
  const all = [...timings.values()].flat()
  console.log(`\n── reads: ${READERS} workers × ${SECONDS}s → ${(all.length / SECONDS).toFixed(0)} req/s, ${errors} errors`)
  for (const [route, xs] of timings) console.log(line(route, xs))
  console.log(line("ALL", all))
}

async function chat(roomId: string, tokens: string[]) {
  const sockets: Socket[] = []
  const sentAt = new Map<string, { at: number; from: number }>()
  const fanout: number[] = []
  let delivered = 0
  await Promise.all(
    tokens.map(
      (token, i) =>
        new Promise<void>((resolve, reject) => {
          const s = io(BASE, { auth: { token }, transports: ["websocket"], reconnection: false })
          s.on("connect", () => {
            s.emit("join:chat", roomId)
            resolve()
          })
          s.on("connect_error", reject)
          s.on("chat:message", ({ message }: { message: { content: string } }) => {
            const tag = message.content.split(" ")[0]
            const sent = sentAt.get(tag)
            if (sent && sent.from !== i) {
              fanout.push(performance.now() - sent.at)
              delivered++
            }
          })
          sockets.push(s)
        })
    )
  )
  await new Promise((r) => setTimeout(r, 1000)) // let every join land

  const post: number[] = []
  let refused = 0
  const until = Date.now() + SECONDS * 1000
  await Promise.all(
    Array.from({ length: SENDERS }, async (_, i) => {
      await new Promise((r) => setTimeout(r, (i * SEND_EVERY_MS) / SENDERS)) // stagger
      for (let n = 0; Date.now() < until; n++) {
        const tag = `L${i}-${n}`
        const words = Array.from({ length: 6 }, (_, k) => WORDS[(i * 7 + n * 3 + k * 5) % WORDS.length])
        const t = performance.now()
        sentAt.set(tag, { at: t, from: i })
        const r = await fetch(`${BASE}/api/mobile/chat/groups/${roomId}/messages`, {
          method: "POST",
          headers: { authorization: `Bearer ${tokens[i]}`, "content-type": "application/json" },
          body: JSON.stringify({ content: `${tag} ${words.join(" ")} ${n}` }),
        })
        await r.arrayBuffer()
        if (r.ok) post.push(performance.now() - t)
        else refused++
        await new Promise((res) => setTimeout(res, Math.max(0, SEND_EVERY_MS - (performance.now() - t))))
      }
    })
  )
  await new Promise((r) => setTimeout(r, 3000)) // stragglers
  sockets.forEach((s) => s.close())

  const expected = post.length * (tokens.length - 1)
  console.log(`\n── chat: ${tokens.length} sockets in one room, ${SENDERS} senders every ${SEND_EVERY_MS / 1000}s for ${SECONDS}s`)
  console.log(line("POST message (sender's wait)", post))
  console.log(line("fan-out (POST start → each socket)", fanout))
  console.log(`delivered ${delivered}/${expected} (${((100 * delivered) / Math.max(1, expected)).toFixed(1)}%), refused ${refused}`)
}

async function main() {
  if (!isLocal(BASE) || !isLocal(process.env.DATABASE_URL ?? "")) throw new Error("load.ts is local only: BASE_URL and DATABASE_URL must be localhost")
  const room = await liveRoom()
  console.log(`room: ${room.id} · members=${MEMBERS} senders=${SENDERS} readers=${READERS} ${SECONDS}s · ${BASE}`)

  const ids: string[] = []
  try {
    for (let i = 0; i < MEMBERS; i++) ids.push(await makeUser(`load-${i}`))
    await onboard(...ids)
    await db.chat_group_members.createMany({
      data: ids.map((user_id, i) => ({ chat_group_id: room.id, user_id, anonymous_name: `Load ${i}` })),
    })
    const tokens = ids.map((id) => signAccessToken(id, `${id}@itest.invalid`))
    await reads(tokens)
    await chat(room.id, tokens)
  } finally {
    await db.chat_messages.deleteMany({ where: { user_id: { in: ids } } })
    await db.chat_group_members.deleteMany({ where: { user_id: { in: ids } } })
    await db.profiles.deleteMany({ where: { id: { in: ids } } })
    await db.user.deleteMany({ where: { id: { in: ids } } })
    await closeDb()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
