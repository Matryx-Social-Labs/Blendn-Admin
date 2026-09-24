import { execFileSync } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * The testing programme's toolbelt — see docs/agents/TEST-PLAN.md.
 *
 *   npm run -s qa bootstrap              staging DB URL → ~/.blendn-qa/pgurl (600)
 *   npm run -s qa sq "SELECT …"          read-only query, pipe-separated rows
 *   npm run -s qa token <email>          a live access token, cached and refreshed
 *   npm run -s qa world                  what is live, soon, and who holds a device
 *   npm run -s qa probe <chatGroupId> <email> [seconds] [post-as <email> <text>]
 *   npm run -s qa lock <device> <tag>    npm run -s qa unlock <device>
 *
 * Scratch lives in ~/.blendn-qa, not /tmp: macOS purges /tmp, and on
 * 2026-09-23 it took the query helper and the Resend key with it mid-run.
 *
 * Staging or localhost only. The API base is an allow-list, the database URL
 * is only ever fetched from Railway's `staging` environment, and every query
 * runs in a READ ONLY transaction — writes go through the product.
 */

export const STAGING_API = "https://staging-api.blendn.app"
const ALLOWED_API_HOSTS = new Set(["staging-api.blendn.app", "localhost", "127.0.0.1"])
const LOCAL_DB_HOSTS = new Set(["localhost", "127.0.0.1"])
const DIR = process.env.BLENDN_QA_DIR ?? join(homedir(), ".blendn-qa")
const STALE_LOCK_MS = 6 * 60 * 60 * 1000

/** Why this API base must not be used, or null when it may. */
export function apiRefusal(base: string): string | null {
  let host: string
  try {
    host = new URL(base).hostname
  } catch {
    return `unparseable API base "${base}"`
  }
  return ALLOWED_API_HOSTS.has(host) ? null : `${host} is neither staging nor local`
}

/** Seconds until a JWT expires; negative once it has. */
export function secondsLeft(jwt: string, now = Date.now()): number {
  try {
    const { exp } = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()) as { exp?: number }
    return exp ? exp - now / 1000 : -1
  } catch {
    return -1
  }
}

function scratch(file = ""): string {
  mkdirSync(DIR, { recursive: true, mode: 0o700 })
  return join(DIR, file)
}

function writePrivate(file: string, body: string) {
  writeFileSync(scratch(file), body, { mode: 0o600 })
}

function railwayVar(service: string, name: string): string {
  const out = execFileSync("railway", ["variables", "--environment", "staging", "--service", service, "--json"], {
    encoding: "utf8",
  })
  const value = (JSON.parse(out) as Record<string, string>)[name]
  if (!value) throw new Error(`${name} is not set on staging/${service}`)
  return value
}

function apiBase(): string {
  const base = process.env.QA_API_BASE ?? STAGING_API
  const refusal = apiRefusal(base)
  if (refusal) throw new Error(`REFUSING: ${refusal}`)
  return base
}

function databaseUrl(): string {
  const local = process.env.QA_DATABASE_URL
  if (local) {
    if (!LOCAL_DB_HOSTS.has(new URL(local).hostname)) throw new Error("REFUSING: QA_DATABASE_URL must be local")
    return local
  }
  if (!existsSync(scratch("pgurl"))) throw new Error("No staging DB URL yet — run `npm run -s qa bootstrap`")
  return readFileSync(scratch("pgurl"), "utf8").trim()
}

async function sq(sql: string): Promise<Record<string, unknown>[]> {
  const { Client } = await import("pg")
  // The connection string decides TLS, exactly as seed-qa's does.
  const client = new Client({ connectionString: databaseUrl() })
  await client.connect()
  try {
    await client.query("BEGIN READ ONLY")
    const result = await client.query(sql)
    await client.query("ROLLBACK")
    return result.rows
  } finally {
    await client.end()
  }
}

function printRows(rows: Record<string, unknown>[]) {
  for (const row of rows) {
    console.log(
      Object.values(row)
        .map((v) => (v instanceof Date ? v.toISOString() : v !== null && typeof v === "object" ? JSON.stringify(v) : String(v)))
        .join("|")
    )
  }
}

/* ------------------------------------------------------------------ tokens */

type Cached = { access: string; refresh: string }

/**
 * One process at a time per machine. A refresh token presented twice is
 * treated as theft and revokes EVERY refresh token on the account — the phone
 * signed in as the same person included — so two sessions refreshing the same
 * cached token at once must not happen.
 */
async function withTokenLock<T>(fn: () => Promise<T>): Promise<T> {
  const lock = scratch("tokens.lock")
  for (let i = 0; ; i++) {
    try {
      closeSync(openSync(lock, "wx"))
      break
    } catch {
      if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 60_000) rmSync(lock, { force: true })
      if (i > 120) throw new Error("token lock held for 60 s")
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  try {
    return await fn()
  } finally {
    rmSync(lock, { force: true })
  }
}

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(`${apiBase()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> }
}

export async function token(email: string): Promise<string> {
  return withTokenLock(async () => {
    const file = scratch("tokens.json")
    const cache: Record<string, Cached> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}
    const save = (c: Cached) => {
      cache[email] = c
      writePrivate("tokens.json", JSON.stringify(cache))
      return c.access
    }
    const mine = cache[email]
    if (mine && secondsLeft(mine.access) > 60) return mine.access

    // Refresh before signing in: sign-ins are limited to 5 per IP per 15
    // minutes and a success counts, a refresh does not.
    if (mine && secondsLeft(mine.refresh) > 60) {
      const r = await post("/api/mobile/auth/refresh", { refreshToken: mine.refresh })
      const data = r.body.data as { accessToken?: string; refreshToken?: string } | undefined
      if (r.status === 200 && data?.accessToken && data.refreshToken) {
        return save({ access: data.accessToken, refresh: data.refreshToken })
      }
    }

    const password = process.env.SEED_PASSWORD ?? railwayVar("Blendn-Admin", "SEED_PASSWORD")
    const r = await post("/api/mobile/auth/signin", { email, password })
    const data = r.body.data as { accessToken?: string; refreshToken?: string } | undefined
    if (r.status !== 200 || !data?.accessToken || !data.refreshToken) {
      throw new Error(`sign-in for ${email} → ${r.status} ${JSON.stringify(r.body)}`)
    }
    return save({ access: data.accessToken, refresh: data.refreshToken })
  })
}

/* ------------------------------------------------------------------- world */

async function world() {
  console.log("── live now, and starting within 48 h")
  printRows(
    await sq(`
      SELECT to_char(e.start_time AT TIME ZONE 'UTC', 'DD Mon HH24:MI') || 'Z' AS starts,
             CASE WHEN now() BETWEEN e.start_time AND e.end_time THEN 'LIVE' ELSE 'soon' END AS state,
             e.title, coalesce(v.name, '(no venue)') AS venue, e.city, e.status,
             coalesce(g.id::text, '(no room yet)') AS room,
             (SELECT count(*) FROM event_check_ins c WHERE c.event_id = e.id AND c.status = 'checked_in') AS inside
        FROM events e
        LEFT JOIN venues v ON v.id = e.venue_id
        LEFT JOIN chat_groups g ON g.event_id = e.id
       WHERE e.deleted_at IS NULL AND e.end_time > now() AND e.start_time < now() + interval '48 hours'
       ORDER BY e.start_time`)
  )
  console.log("── attendee lanes: room memberships that are not plain active")
  printRows(
    await sq(`
      SELECT u.email, m.status, g.name
        FROM chat_group_members m
        JOIN "User" u ON u.id = m.user_id
        JOIN chat_groups g ON g.id = m.chat_group_id
       WHERE u.email LIKE '%@blendn.app' AND m.status IN ('muted', 'banned') AND g.status <> 'archived'`)
  )
  console.log("── device locks on this machine")
  const locks = scratch("locks")
  mkdirSync(locks, { recursive: true })
  for (const f of readdirSync(locks)) console.log(`${f}: ${readFileSync(join(locks, f), "utf8").trim()}`)
}

/* ------------------------------------------------------------------- locks */

function lock(device: string, tag: string) {
  const file = join(scratch("locks"), device.replace(/[^\w.-]/g, "_"))
  mkdirSync(scratch("locks"), { recursive: true })
  if (existsSync(file)) {
    const age = Date.now() - statSync(file).mtimeMs
    if (age < STALE_LOCK_MS) throw new Error(`${device} is held: ${readFileSync(file, "utf8").trim()}`)
  }
  writePrivate(join("locks", device.replace(/[^\w.-]/g, "_")), `${tag} since ${new Date().toISOString()}\n`)
  console.log(`locked ${device} for ${tag}`)
}

/* ------------------------------------------------------------------- probe */

const PROBE_USAGE = "usage: qa probe <chatGroupId> <email> [seconds] [post-as <email> <text>]"
const PROBE_DEFAULT_SECONDS = 20

export interface ProbeArgs {
  groupId: string
  email: string
  seconds: number
  postAs?: string
  text?: string
}

/**
 * `probe`'s arguments, refusing any it would otherwise ignore.
 *
 * `npm run -s qa probe … --post-as rohan@ hi` hands this `… rohan@ hi`: npm 11
 * keeps `--post-as` as its own config flag. This used to parse that as a
 * listen-only probe without a word, and a probe exists to show a banned socket
 * hearing nothing — so it passed whether or not the ban evicted anyone
 * (SCRUM-284). The keyword is `post-as`, which npm passes through; the flag
 * still works where npm is not in the way (`npm run -s qa -- probe …`).
 */
export function probeArgs(args: readonly string[]): ProbeArgs {
  const [groupId, email, ...rest] = args
  if (!groupId || !email) throw new Error(PROBE_USAGE)
  // Seconds are optional, so only a positive whole number is taken as them —
  // `Number("--post-as")` was NaN, which closed the socket as it posted.
  const hasSeconds = /^[1-9]\d*$/.test(rest[0] ?? "")
  const seconds = hasSeconds ? Number(rest[0]) : PROBE_DEFAULT_SECONDS
  const tail = hasSeconds ? rest.slice(1) : rest
  if (tail.length === 0) return { groupId, email, seconds }

  const [keyword, postAs, ...words] = tail
  if ((keyword === "post-as" || keyword === "--post-as") && postAs?.includes("@") && words.length > 0) {
    return { groupId, email, seconds, postAs, text: words.join(" ") }
  }
  throw new Error(
    `probe: will not ignore "${tail.join(" ")}". npm drops --flags, so a post is "post-as <email> <text>". ${PROBE_USAGE}`
  )
}

/**
 * Hold a real socket in a room and print everything it hears. Live delivery is
 * a socket probe, not a screenshot (TESTING-PLAYBOOK §8): a REST 201 does not
 * prove the room heard it, and a ban's eviction can only be seen from inside.
 */
async function probe(groupId: string, email: string, seconds: number, postAs?: string, text?: string) {
  const { io } = await import("socket.io-client")
  const socket = io(apiBase(), { auth: { token: await token(email) }, transports: ["websocket"] })
  const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a)
  socket.on("connect", () => {
    log(`connected as ${email}`)
    socket.emit("join:chat", groupId)
  })
  socket.on("connect_error", (e: Error) => log("connect_error", e.message))
  socket.onAny((event: string, payload: unknown) => log(event, JSON.stringify(payload).slice(0, 200)))
  if (postAs && text) {
    await new Promise((r) => setTimeout(r, 3000))
    const r = await post(`/api/mobile/chat/groups/${groupId}/messages`, { content: text }, await token(postAs))
    log(`POST as ${postAs} → ${r.status}`)
  }
  await new Promise((r) => setTimeout(r, seconds * 1000))
  socket.close()
}

/* -------------------------------------------------------------------- main */

async function main() {
  const [cmd, ...args] = process.argv.slice(2)
  switch (cmd) {
    case "bootstrap": {
      writePrivate("pgurl", railwayVar("Postgres", "DATABASE_PUBLIC_URL"))
      const [row] = await sq("SELECT current_database() AS db, now() AS at")
      console.log(`staging DB reachable (${row.db}); scratch in ${DIR}`)
      break
    }
    case "sq":
      printRows(await sq(args.join(" ")))
      break
    case "token":
      console.log(await token(args[0]))
      break
    case "world":
      await world()
      break
    case "lock":
      lock(args[0], args[1] ?? "unnamed")
      break
    case "unlock":
      rmSync(join(scratch("locks"), args[0].replace(/[^\w.-]/g, "_")), { force: true })
      console.log(`unlocked ${args[0]}`)
      break
    case "probe": {
      const p = probeArgs(args)
      await probe(p.groupId, p.email, p.seconds, p.postAs, p.text)
      break
    }
    default:
      console.log("usage: qa bootstrap | sq <sql> | token <email> | world | lock <device> <tag> | unlock <device> | probe <group> <email> [s] [post-as <email> <text>]")
      process.exitCode = cmd ? 1 : 0
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
