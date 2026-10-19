import { Client } from "pg"

/**
 * What SQL a piece of code sent, and in what shape: how many statements, how
 * many ran at once, and how many sequential waves they came in.
 *
 * Patches `pg.Client.prototype.query`, which both this directory's pool and
 * the app's own (`lib/db`) check their connections out of. A latency fix here
 * is about the *shape* of the traffic (a Singapore round trip is paid per
 * wave, not per row), and a mocked `db` can say nothing about that.
 */
export interface Statement {
  sql: string
  start: number
  end: number
}

const TRANSACTION_CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK|SET\b|SHOW\b)/i

export async function recordStatements<T>(
  run: () => Promise<T>
): Promise<{ result: T; statements: Statement[] }> {
  const statements: Statement[] = []
  const original = Client.prototype.query
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(Client.prototype as any).query = function (this: Client, ...args: unknown[]) {
    const first = args[0] as string | { text?: string } | undefined
    const sql = typeof first === "string" ? first : (first?.text ?? "")
    const start = performance.now()
    const counted = !TRANSACTION_CONTROL.test(sql)
    const done = () => {
      if (counted) statements.push({ sql, start, end: performance.now() })
    }
    // `pool.query` (what the Prisma adapter calls) reaches the client with a
    // callback; a checked-out client is awaited. Cover both.
    const last = args.length - 1
    if (typeof args[last] === "function") {
      const cb = args[last] as (...a: unknown[]) => void
      args[last] = (...a: unknown[]) => {
        done()
        cb(...a)
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (original as any).apply(this, args)
    if (out && typeof out.then === "function") out.then(done, done)
    return out
  }
  try {
    const result = await run()
    /*
     * Every assertion on these is "no statement looks like X", which a recorder
     * that saw nothing satisfies. A driver that stops going through
     * `pg.Client.query` would turn every such test green; fail it here instead.
     */
    if (statements.length === 0) throw new Error("recordStatements saw no SQL: the recorder is not attached to the driver")
    return { result, statements }
  } finally {
    Client.prototype.query = original
  }
}

/** The most statements in flight at the same instant. */
export function peakConcurrency(statements: Statement[]): number {
  const edges = statements.flatMap((s) => [
    { at: s.start, d: 1 },
    { at: s.end, d: -1 },
  ])
  edges.sort((a, b) => a.at - b.at || a.d - b.d)
  let live = 0
  let peak = 0
  for (const e of edges) {
    live += e.d
    peak = Math.max(peak, live)
  }
  return peak
}

/**
 * Sequential waves: a statement that starts after every earlier one has
 * finished opens a new wave. Statements that overlap in time share one.
 */
export function waves(statements: Statement[]): number {
  const sorted = [...statements].sort((a, b) => a.start - b.start)
  let count = 0
  let frontier = -Infinity
  for (const s of sorted) {
    if (s.start >= frontier) count += 1
    frontier = Math.max(frontier, s.end)
  }
  return count
}

export const shape = (statements: Statement[]) =>
  `${statements.length} statements, ${waves(statements)} waves, peak ${peakConcurrency(statements)} at once`
