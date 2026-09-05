/**
 * The E2E suite, locally, in one command.
 *
 * ## Why this exists
 *
 * **The CI lane runs on every PR again** — this paragraph used to say it was
 * gated off, and that stopped being true the day the cause was found. Recorded
 * rather than deleted, because the diagnosis is the useful part: the suite was
 * not leaking. `npm run start` does not set `NODE_ENV`, so `node dist/server.js`
 * ran Next.js in **development mode** and compiled every route on demand —
 * 6,904MB against 458MB with it set. Three earlier diagnoses (Actions quota
 * twice, then an external memory leak) were all wrong.
 *
 * What still runs only here is the two exhaustive sweeps, which the PR lane
 * excludes for time; nightly and the `full-e2e` label run everything.
 *
 * It has to be *one command* either way. The sequence
 * it replaces — migrate, seed, build, start a production server, poll health,
 * run Playwright against the right port, then remember to kill the server — is
 * six steps with two easy mistakes in it: testing a stale build, and leaving a
 * server holding the port so the next run silently tests the previous one.
 *
 * ## What it deliberately does NOT do
 *
 * It does not use `next dev`. `server.ts` is the real entry point — it attaches
 * Socket.io and starts the background loops, and it is what production runs. A
 * suite that passed against `next dev` would be testing a different program.
 *
 * It does not reuse an already-running server, for the same reason it does not
 * skip the build: the failure mode of a fast path here is a green run against
 * code that is no longer on disk.
 */
import { spawn, spawnSync, type ChildProcess } from "child_process"
import { mkdtempSync, createWriteStream } from "fs"
import { tmpdir } from "os"
import { join } from "path"

/**
 * A separate port from the default 3000, on purpose.
 *
 * A `next dev` server is very often already running on 3000 during
 * development, and it would answer the health poll — at which point the suite
 * runs against the dev server, passes or fails for reasons unrelated to the
 * build, and says nothing useful either way.
 */
const PORT = process.env.PORT ?? "3100"
const BASE = `http://localhost:${PORT}`

function run(cmd: string, args: string[], label: string) {
  process.stdout.write(`\n── ${label} ──\n`)
  const r = spawnSync(cmd, args, { stdio: "inherit", env: process.env })
  if (r.status !== 0) {
    process.stdout.write(`\n${label} failed (exit ${r.status}).\n`)
    process.exit(r.status ?? 1)
  }
}

async function healthy(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`)
      if (res.ok) return true
    } catch {
      // Not up yet. The loop is the wait.
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}

async function main() {
  if (!process.env.DATABASE_URL) {
    process.stdout.write(
      "DATABASE_URL is not set. The suite reads a seeded world and writes to it,\n" +
        "so point this at a scratch database rather than your development one.\n"
    )
    process.exit(1)
  }

  /*
   * Refused rather than reused. If something already answers on this port the
   * suite would run against it and report on a build that is not the one just
   * made — the most misleading outcome available here.
   */
  if (await healthy(1500)) {
    process.stdout.write(
      `Something is already serving ${BASE}.\n` +
        `Stop it first: the suite would test that process instead of this build.\n`
    )
    process.exit(1)
  }

  run("npm", ["run", "db:migrate"], "migrations")
  run("npm", ["run", "seed:qa", "--", "--apply"], "seed")
  run("npm", ["run", "build"], "build")

  const logPath = join(mkdtempSync(join(tmpdir(), "e2e-local-")), "server.log")
  const log = createWriteStream(logPath)
  process.stdout.write(`\n── server (log: ${logPath}) ──\n`)

  const server: ChildProcess = spawn("npm", ["run", "start"], {
    env: { ...process.env, PORT, NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  server.stdout?.pipe(log)
  server.stderr?.pipe(log)

  /*
   * With MEMORY_TRACE on, the server's output also goes to our stdout. The
   * whole point of that flag is to be read, and piping it into a temp file
   * nobody opens is how it came to be switched on for a full run and produce
   * nothing anyone saw — the same mistake as writing CI diagnostics to a file
   * on a runner that is about to be taken away.
   */
  if (process.env.MEMORY_TRACE === "1") {
    server.stdout?.pipe(process.stdout)
    server.stderr?.pipe(process.stdout)
  }

  /*
   * Killed however this exits, Ctrl-C included. A server left holding the port
   * makes the *next* run test the previous build — the exact failure the
   * refusal above is written to catch, arriving from our own untidiness.
   */
  const stop = () => {
    if (!server.killed) server.kill("SIGTERM")
  }
  process.on("exit", stop)
  process.on("SIGINT", () => {
    stop()
    process.exit(130)
  })

  if (!(await healthy(90_000))) {
    stop()
    process.stdout.write(`\nServer did not become healthy in 90s. Log: ${logPath}\n`)
    process.exit(1)
  }

  // Extra arguments pass through, so a single spec is
  // `npm run test:e2e:local -- e2e/venue-pin.spec.ts`.
  const r = spawnSync("npx", ["playwright", "test", ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, E2E_BASE_URL: BASE },
  })

  stop()
  if (r.status !== 0) {
    process.stdout.write(`\nSuite failed. Server log: ${logPath}\n`)
  }
  process.exit(r.status ?? 1)
}

void main()
