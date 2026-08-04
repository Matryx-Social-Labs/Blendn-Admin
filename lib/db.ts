import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

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
function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set")
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
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
