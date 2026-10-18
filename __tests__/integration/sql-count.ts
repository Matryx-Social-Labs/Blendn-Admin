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
  const spans: { start: number; end: number }[] = []
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
    log: [{ emit: "event", level: "query" }],
  })
  client.$on("query", (e) => {
    // Transaction control is not a round trip worth counting against the route.
    if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(e.query)) return
    statements.push(e.query)
    const end = e.timestamp.getTime()
    spans.push({ start: end - Number(e.duration), end })
  })
  globalThis.prisma = client
  return {
    statements,
    reset: () => void (statements.length = 0),
    /** Run `fn` with a clean counter; the statements it issued. */
    async during<T>(fn: () => Promise<T>): Promise<{ result: T; sql: string[]; levels: number }> {
      statements.length = 0
      spans.length = 0
      const result = await fn()
      return { result, sql: [...statements], levels: levelsOf(spans) }
    },
    async stop() {
      globalThis.prisma = previous
      await client.$disconnect()
    },
  }
}

/**
 * How many times the request waited on the database in series: statements that
 * overlapped in time are one level. A measure, to read beside the statement
 * count; at millisecond resolution it can merge two quick levels, never invent one.
 */
function levelsOf(spans: { start: number; end: number }[]): number {
  let levels = 0
  let reach = -Infinity
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    if (span.start >= reach) levels += 1
    reach = Math.max(reach, span.end)
  }
  return levels
}
