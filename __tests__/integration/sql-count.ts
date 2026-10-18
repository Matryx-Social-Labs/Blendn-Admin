import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

/**
 * Counts the SQL statements a request really issues, not the Prisma
 * operations (`query-budget.itest.ts` counts those): Prisma 7 runs every
 * `include` level as its own statement, even under a parent that is null, so
 * one `findUnique` can be thirty-odd round trips. Assigned to
 * `globalThis.prisma`, which `lib/db.ts` re-reads on every access.
 */
export function sqlCounter() {
  const previous = globalThis.prisma
  const statements: string[] = []
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
    log: [{ emit: "event", level: "query" }],
  })
  client.$on("query", (e) => {
    // Transaction control is not a round trip worth counting against the route.
    if (!/^(BEGIN|COMMIT|ROLLBACK)/i.test(e.query)) statements.push(e.query)
  })
  globalThis.prisma = client
  return {
    statements,
    reset: () => void (statements.length = 0),
    /** Run `fn` with a clean counter; the statements it issued. */
    async during<T>(fn: () => Promise<T>): Promise<{ result: T; sql: string[] }> {
      statements.length = 0
      const result = await fn()
      return { result, sql: [...statements] }
    },
    async stop() {
      globalThis.prisma = previous
      await client.$disconnect()
    },
  }
}
