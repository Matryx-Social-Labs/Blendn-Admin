import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { Pool } from "pg"

declare global {
  var prisma: PrismaClient | undefined
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
 * Five background loops, Socket.io and every request handler share this pool.
 * Env-overridable because the right ceiling is a property of the Postgres plan,
 * not of the code.
 */
const POOL_MAX = Number(process.env.DATABASE_POOL_MAX ?? 20)

/**
 * The pool, held rather than handed to the adapter and forgotten.
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
let pool: Pool | null = null

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set")
  }
  pool = new Pool({ connectionString, max: POOL_MAX })
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
  const owned = pool
  pool = null
  if (client) await client.$disconnect().catch(() => {})
  if (owned) await owned.end().catch(() => {})
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
