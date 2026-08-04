/**
 * Performance baseline.
 *
 *   BASE_URL=https://staging-api.blendn.app npx tsx scripts/bench.ts
 *   BASE_URL=... npx tsx scripts/bench.ts --compare baseline.json
 *
 * Captures build output size and endpoint latency so a framework or ORM major
 * (Next 16, Prisma 7) can be checked for regression instead of assumed fine.
 *
 * Deliberately modest: several samples per endpoint, median reported, and a
 * threshold wide enough that normal noise doesn't cry wolf. A benchmark that
 * fires false alarms gets ignored, which is worse than not having one.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs"
import { join } from "path"

const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "")
const SAMPLES = Number(process.env.BENCH_SAMPLES ?? 7)
const WARMUP = 2
/** Below this, differences are noise on a shared host, not a regression. */
const REGRESSION_FACTOR = 1.5

/**
 * Unauthenticated paths. These measure the latency floor — HTTP round trip,
 * Node, and a 401 — NOT application work. Kept for the floor, but on their own
 * they are not a performance test: the original four endpoints never executed a
 * single application query.
 */
const ENDPOINTS = [
  { name: "health", path: "/api/health" },
  { name: "openapi-spec", path: "/api/docs" },
  { name: "login-page", path: "/login" },
  { name: "mobile-events-unauth", path: "/api/mobile/events" },
]

/**
 * The paths that actually do work. `events` alone issues 5 DB calls with 17
 * include/selects; the messages route issues 9. These only run when
 * BENCH_EMAIL / BENCH_PASSWORD are set, and are reported as SKIPPED otherwise
 * rather than quietly shortening the run.
 */
const AUTHED_ENDPOINTS = [
  { name: "events (authed)", path: "/api/mobile/events?limit=20" },
  { name: "events + interested", path: "/api/mobile/events?limit=20&include=interestedPreview" },
  { name: "chat groups + unread", path: "/api/mobile/chat/groups" },
  { name: "active checkins", path: "/api/mobile/checkins/active" },
  { name: "categories", path: "/api/mobile/categories" },
]

type Sample = { name: string; medianMs: number; minMs: number; maxMs: number; status: number }
type Report = { capturedAt: string; base: string; bundleKb: number | null; endpoints: Sample[] }

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function bundleSizeKb(): number | null {
  const dir = join(process.cwd(), ".next", "static")
  if (!existsSync(dir)) return null
  let total = 0
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else if (entry.endsWith(".js")) total += st.size
    }
  }
  walk(dir)
  return Math.round(total / 1024)
}

async function timeEndpoint(path: string, token?: string): Promise<{ ms: number[]; status: number }> {
  const ms: number[] = []
  let status = 0
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined
  for (let i = 0; i < SAMPLES + WARMUP; i++) {
    const t0 = performance.now()
    const res = await fetch(`${BASE}${path}`, { headers, signal: AbortSignal.timeout(30_000) })
    await res.arrayBuffer()
    const dt = performance.now() - t0
    status = res.status
    // Discard warmups: the first calls pay cold-start and TLS setup, which
    // would otherwise dominate the median and hide real movement.
    if (i >= WARMUP) ms.push(dt)
  }
  return { ms, status }
}

async function capture(): Promise<Report> {
  const endpoints: Sample[] = []
  for (const e of ENDPOINTS) {
    const { ms, status } = await timeEndpoint(e.path)
    endpoints.push({
      name: e.name,
      medianMs: Math.round(median(ms)),
      minMs: Math.round(Math.min(...ms)),
      maxMs: Math.round(Math.max(...ms)),
      status,
    })
    const last = endpoints[endpoints.length - 1]
    console.log(`  ${e.name.padEnd(22)} ${String(last.medianMs).padStart(5)}ms median  (${last.minMs}-${last.maxMs}ms)  HTTP ${status}`)
  }
  // Authenticated lanes. A 401 here would silently look "fast", so the status
  // is recorded alongside the timing and anything non-200 is called out.
  const email = process.env.BENCH_EMAIL
  const password = process.env.BENCH_PASSWORD
  if (email && password) {
    const res = await fetch(`${BASE}/api/mobile/auth/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    })
    const body = (await res.json()) as { data?: { accessToken?: string } }
    const token = body?.data?.accessToken
    if (!token) {
      console.log("  authenticated lanes SKIPPED — sign-in failed")
    } else {
      for (const e of AUTHED_ENDPOINTS) {
        const { ms, status } = await timeEndpoint(e.path, token)
        const s: Sample = {
          name: e.name,
          medianMs: Math.round(median(ms)),
          minMs: Math.round(Math.min(...ms)),
          maxMs: Math.round(Math.max(...ms)),
          status,
        }
        endpoints.push(s)
        const warn = status !== 200 ? `  <-- HTTP ${status}, not measuring real work` : ""
        console.log(`  ${e.name.padEnd(22)} ${String(s.medianMs).padStart(5)}ms median  (${s.minMs}-${s.maxMs}ms)  HTTP ${status}${warn}`)
      }
    }
  } else {
    console.log("  authenticated lanes SKIPPED — set BENCH_EMAIL and BENCH_PASSWORD")
  }

  const bundleKb = bundleSizeKb()
  console.log(`  ${"client bundle".padEnd(22)} ${bundleKb === null ? "n/a (no .next build)" : bundleKb + " KB"}`)
  return { capturedAt: new Date().toISOString(), base: BASE, bundleKb, endpoints }
}

function compare(now: Report, before: Report) {
  console.log(`\nComparing against baseline from ${before.capturedAt}\n`)
  let regressions = 0

  if (now.bundleKb !== null && before.bundleKb !== null) {
    const ratio = now.bundleKb / before.bundleKb
    const flag = ratio >= REGRESSION_FACTOR
    if (flag) regressions++
    console.log(
      `  bundle: ${before.bundleKb} KB -> ${now.bundleKb} KB (${(ratio * 100 - 100).toFixed(1)}%)${flag ? "  ** REGRESSION **" : ""}`
    )
  }

  for (const e of now.endpoints) {
    const b = before.endpoints.find((x) => x.name === e.name)
    if (!b) { console.log(`  ${e.name}: new, no baseline`); continue }
    const ratio = e.medianMs / Math.max(b.medianMs, 1)
    const flag = ratio >= REGRESSION_FACTOR
    if (flag) regressions++
    console.log(
      `  ${e.name.padEnd(22)} ${String(b.medianMs).padStart(5)}ms -> ${String(e.medianMs).padStart(5)}ms  (${(ratio * 100 - 100).toFixed(0)}%)${flag ? "  ** REGRESSION **" : ""}`
    )
  }

  console.log(
    regressions
      ? `\n${regressions} regression(s) beyond ${REGRESSION_FACTOR}x. Investigate before promoting.\n`
      : `\nNo regression beyond ${REGRESSION_FACTOR}x.\n`
  )
  return regressions
}

async function main() {
  const compareIdx = process.argv.indexOf("--compare")
  const outIdx = process.argv.indexOf("--out")

  console.log(`\nBenchmark against ${BASE} (${SAMPLES} samples, ${WARMUP} warmup)\n`)
  const report = await capture()

  if (outIdx !== -1 && process.argv[outIdx + 1]) {
    writeFileSync(process.argv[outIdx + 1], JSON.stringify(report, null, 2))
    console.log(`\nbaseline written to ${process.argv[outIdx + 1]}`)
  }

  if (compareIdx !== -1 && process.argv[compareIdx + 1]) {
    const path = process.argv[compareIdx + 1]
    if (!existsSync(path)) { console.error(`baseline not found: ${path}`); process.exit(1) }
    const regressions = compare(report, JSON.parse(readFileSync(path, "utf8")) as Report)
    if (regressions) process.exit(1)
  }
}

main().catch((e) => { console.error("benchmark failed:", e); process.exit(1) })
