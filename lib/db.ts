import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { Pool } from "pg"

declare global {
  var prisma: PrismaClient | undefined
  /**
   * The pool, held rather than handed to the adapter and forgotten, and on
   * `globalThis` beside `prisma` rather than module-local (SCRUM-1221): Next
   * bundles its own copy of this module and `server.ts` builds the client first,
   * so a module-local pool read `null` in the Next layer (the `/api/health`
   * gauge) and `closeDb()` ended it only from the copy that built it.
   *
   * `prisma.$disconnect()` does **not** close a pool the adapter created. The
   * integration helper's own docblock says so in as many words, and closes both
   * its client and its pool for exactly this reason — but nothing did the same
   * for this one. Two consequences, and the second is not a test problem:
   *
   *   1. Every jest suite that touched `lib/db` leaked up to `POOL_MAX`
   *      connections for the length of the run. Sequential suites are supposed
   *      to be cheap; 35 of them at twenty apiece is `sorry, too many clients
   *      already`, with real routes returning 500 because the pool was gone.
   *   2. `server.ts` calls `db.$disconnect()` on SIGTERM under a comment saying
   *      "Drain the connection pool", and it does not. Connections are dropped
   *      when the process exits rather than closed, which on a rolling deploy is
   *      the old container's sockets lingering while the new one is opening its
   *      own.
   */
  var prismaPool: Pool | undefined
}

/**
 * Prisma 7 no longer reads the connection URL from schema.prisma — the runtime
 * client takes a driver adapter, and the CLI reads its URL from
 * prisma.config.ts.
 *
 * Construction is LAZY, and that is load-bearing. Next imports route modules
 * while collecting build configuration, when DATABASE_URL is not necessarily
 * set; building the adapter at import time made `next build` fail with
 * "DATABASE_URL is not set" on every route that touches the database. Prisma 6
 * resolved the URL lazily through `env()` in the schema, so this restores the
 * behaviour the rest of the codebase was written against.
 *
 * The singleton matters more than it looks: server.ts is a long-running process
 * with Socket.io attached, so a client per import would open a new connection
 * pool each time and exhaust Postgres. In development the global also survives
 * hot reloads.
 */
/**
 * How many connections this process may hold.
 *
 * `pg` defaults to 10 and nothing set it, which is the wrong number here for a
 * specific reason: one live-ops tick issues nine concurrent queries in a single
 * `Promise.all`, so a single watched event took 90% of the pool for the length
 * of a tick, twelve times a minute. Two watched events queued. That is the most
 * likely mechanism behind the timeouts the mobile client built a request queue
 * to work around.
 *
 * Twelve background loops (`lib/background.ts`), Socket.io and every request
 * handler share this pool.
 * Env-overridable because the right ceiling is a property of the Postgres plan,
 * not of the code.
 */
const POOL_MAX = Number(process.env.DATABASE_POOL_MAX ?? 20)

/**
 * How long an idle connection stays open. pg-pool's default is 10 s, so on a
 * quiet server every connection had closed before the next request, which then
 * paid SCRAM sign-in and a new Postgres backend for each of the 8–12 queries it
 * runs at once: 35–60 ms on staging for the first request after any pause
 * (chat/groups 145 ms cold vs 84 ms warm, 2026-10-18). With few users that
 * first request is the ordinary one. TCP keepalive notices a connection the
 * network dropped while it sat idle.
 */
const POOL_IDLE_MS = 5 * 60_000

/**
 * How long a query waits for a connection when all `POOL_MAX` are busy.
 * pg-pool's default is 0, wait for ever: one slow query or a doors-open burst of
 * 11-query fan-outs queued every request with no limit, the app gave up at 15 s
 * and retried into the same queue. Now the waiter fails after 5 s ("timeout
 * exceeded when trying to connect"), which the route turns into a fast 500.
 */
const POOL_ACQUIRE_TIMEOUT_MS = 5_000

/**
 * `statement_timeout` for every connection of this pool, from
 * `DATABASE_STATEMENT_TIMEOUT_MS`. Unset means none: `server.ts` sets 8000
 * before anything connects, and scripts (seeds, backfills, imports) that use
 * this module leave it unset and keep no cap. `0` turns it off explicitly, as
 * in Postgres. Anything else is refused loudly rather than ignored, because a
 * typo would otherwise switch the cap off without a word.
 */
function statementTimeoutMs(): number | undefined {
  const raw = process.env.DATABASE_STATEMENT_TIMEOUT_MS?.trim()
  if (!raw) return undefined
  if (!/^\d+$/.test(raw)) {
    throw new Error(`DATABASE_STATEMENT_TIMEOUT_MS must be whole milliseconds, got "${raw}"`)
  }
  return Number(raw)
}

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set")
  }
  const pool = new Pool({
    connectionString,
    max: POOL_MAX,
    idleTimeoutMillis: POOL_IDLE_MS,
    keepAlive: true,
    connectionTimeoutMillis: POOL_ACQUIRE_TIMEOUT_MS,
    // A startup parameter: every backend the pool opens has it from the first statement.
    statement_timeout: statementTimeoutMs(),
  })
  globalThis.prismaPool = pool
  return new PrismaClient({ adapter: new PrismaPg(pool) })
}

/**
 * Disconnect the client AND end the pool it is using.
 *
 * Both, in that order: `$disconnect` lets in-flight queries settle, `pool.end`
 * is what actually closes the sockets.
 */
export async function closeDb(): Promise<void> {
  const client = globalThis.prisma
  globalThis.prisma = undefined
  const owned = globalThis.prismaPool
  globalThis.prismaPool = undefined
  if (client) await client.$disconnect().catch(() => {})
  if (owned) await owned.end().catch(() => {})
}

/** The pool's counts for `/api/health`; `null` until the first query builds it. */
export function poolStats(): { total: number; idle: number; waiting: number } | null {
  const pool = globalThis.prismaPool
  return pool ? { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount } : null
}

function getClient(): PrismaClient {
  if (!globalThis.prisma) {
    globalThis.prisma = createClient()
  }
  return globalThis.prisma
}

/**
 * Proxied so the real client is built on first use rather than on import.
 * Every access forwards to the live client, so `db.user.findMany()`,
 * `db.$queryRaw` and `db.$transaction` all behave exactly as before.
 */
export const db = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    const client = getClient()
    const value = Reflect.get(client, prop, receiver)
    return typeof value === "function" ? value.bind(client) : value
  },
  has(_target, prop) {
    return Reflect.has(getClient(), prop)
  },
})
