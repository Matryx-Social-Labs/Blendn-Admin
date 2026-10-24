import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

/**
 * Hold every Prisma operation for `lagMs`, and keep when each began and ended.
 *
 * Two reads that run side by side then overlap unmistakably, and two that run
 * in series are `lagMs` apart; a millisecond-resolution race cannot flip it.
 * Assigned to `globalThis.prisma`, which `lib/db.ts` re-reads on every access.
 * Same idea as dm-send-parallel.itest.ts on the chat branch.
 */
export interface Span {
  op: string
  start: number
  end: number
}

export function laggedDb(lagMs: number) {
  const spans: Span[] = []
  let base: PrismaClient | undefined
  let previous: PrismaClient | undefined

  return {
    spans,
    install() {
      previous = globalThis.prisma
      base = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })
      globalThis.prisma = base.$extends({
        query: {
          async $allOperations({ model, operation, args, query }: { model?: string; operation: string; args: unknown; query: (a: unknown) => Promise<unknown> }) {
            const span = { op: `${model ?? ""}.${operation}`, start: performance.now(), end: 0 }
            spans.push(span)
            await new Promise((r) => setTimeout(r, lagMs))
            try {
              return await query(args)
            } finally {
              span.end = performance.now()
            }
          },
        },
      }) as unknown as PrismaClient
    },
    async restore() {
      globalThis.prisma = previous
      await base?.$disconnect()
    },
    reset: () => void (spans.length = 0),
    /** Did the `ai`-th span named `a` run at the same time as the `bi`-th named `b`? (Both default to the first.) */
    overlap(a: string, b: string, ai = 0, bi = 0): boolean {
      const x = spans.filter((s) => s.op === a)[ai]
      const y = spans.filter((s) => s.op === b)[bi]
      if (!x || !y) throw new Error(`missing ${!x ? a : b} in ${spans.map((s) => s.op).join(", ")}`)
      return x.start < y.end && y.start < x.end
    },
    /** Sequential waves: an operation that starts after every earlier one has ended opens a new one. */
    waves(): number {
      let count = 0
      let reach = -Infinity
      for (const s of [...spans].sort((p, q) => p.start - q.start)) {
        if (s.start >= reach) count += 1
        reach = Math.max(reach, s.end)
      }
      return count
    },
  }
}
