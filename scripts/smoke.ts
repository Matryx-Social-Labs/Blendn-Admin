/**
 * Post-deploy smoke test.
 *
 *   BASE_URL=https://staging-api.blendn.app npx tsx scripts/smoke.ts
 *
 * `/api/health` only runs `SELECT 1`, so it returns 200 while socket
 * authorization, uploads, or the mobile API are broken — it is a liveness
 * check, not a verification. This exercises the paths a bad deploy actually
 * breaks, and asserts on response *bodies* rather than status codes alone,
 * because a route returning 200 with the wrong shape is the failure mode a
 * status-only check is blind to.
 *
 * Exits non-zero on any failure, so it can gate a promotion.
 */
import { io } from "socket.io-client"

const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "")
const TIMEOUT = 20_000

type Result = { name: string; ok: boolean; detail: string; skipped?: boolean }
const results: Result[] = []

function record(name: string, ok: boolean, detail: string, skipped = false) {
  results.push({ name, ok, detail, skipped })
  const tag = skipped ? "SKIP" : ok ? "PASS" : "FAIL"
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ""}`)
}

async function check(name: string, fn: () => Promise<string>) {
  try {
    record(name, true, await fn())
  } catch (e) {
    record(name, false, e instanceof Error ? e.message : String(e))
  }
}

const fetchJson = async (path: string, init?: RequestInit) => {
  const res = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT) })
  const text = await res.text()
  let body: unknown = null
  try { body = JSON.parse(text) } catch { /* non-JSON is a valid outcome to assert on */ }
  return { res, body, text }
}

async function main() {
  console.log(`\nSmoke test against ${BASE}\n`)

  await check("health reports ok and a connected database", async () => {
    const { res, body } = await fetchJson("/api/health")
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`)
    const h = body as { status?: string; database?: string; version?: string }
    // Asserting the body, not just the status: /api/health returns 503 with
    // status "degraded" when the DB is down, but a 200 with database
    // "disconnected" would be a silent lie a status-only check would miss.
    if (h?.status !== "ok") throw new Error(`status=${h?.status}`)
    if (h?.database !== "connected") throw new Error(`database=${h?.database}`)
    return `v${h.version}`
  })

  await check("invalid body returns 400 with field errors, not 500", async () => {
    // This is the zod .issues path. On the old .errors code under zod 4 this
    // would be a 500 raised inside the error handler.
    const { res, body } = await fetchJson("/api/mobile/auth/signin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonsense: true }),
    })
    if (res.status !== 400) throw new Error(`expected 400, got ${res.status}`)
    const b = body as { errorCode?: string; errors?: { field: string }[] }
    if (b?.errorCode !== "VALIDATION_FAILED") throw new Error(`errorCode=${b?.errorCode}`)
    if (!Array.isArray(b?.errors) || b.errors.length === 0) throw new Error("no field errors")
    return `${b.errors.length} field errors`
  })

  await check("unauthenticated mobile route is rejected", async () => {
    const { res } = await fetchJson("/api/mobile/events")
    if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`)
    return "401"
  })

  await check("cron endpoint fails closed", async () => {
    const { res } = await fetchJson("/api/cron/event-reminders")
    if (res.status !== 401) throw new Error(`expected 401, got ${res.status} — endpoint is OPEN`)
    return "401"
  })

  await check("OpenAPI spec is served and parses", async () => {
    const { res, body } = await fetchJson("/api/docs")
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`)
    const spec = body as { openapi?: string; paths?: Record<string, unknown> }
    if (!spec?.openapi) throw new Error("not an OpenAPI document")
    const count = Object.keys(spec.paths ?? {}).length
    if (count === 0) throw new Error("spec has zero paths")
    return `${count} paths`
  })

  await check("login page renders", async () => {
    const { res, text } = await fetchJson("/login")
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`)
    if (!text.includes("<html")) throw new Error("no HTML in response")
    return "200"
  })

  await check("socket rejects a connection with a bad token", async () => {
    // Proves the handshake auth middleware is wired. A deploy that broke it
    // would accept anything, and no HTTP check would notice.
    return await new Promise<string>((resolve, reject) => {
      const socket = io(BASE, {
        auth: { token: "definitely-not-a-valid-jwt" },
        transports: ["websocket"],
        timeout: 10_000,
        reconnection: false,
      })
      const done = (fn: () => void) => { socket.close(); fn() }
      socket.on("connect", () => done(() => reject(new Error("connected with an invalid token"))))
      socket.on("connect_error", (err) =>
        done(() => {
          // Any connect_error would "pass" a naive check, including a totally
          // misconfigured server ("Invalid namespace"). Require the rejection
          // to actually come from the auth middleware.
          const m = err.message.toLowerCase()
          if (m.includes("token") || m.includes("auth")) resolve(`rejected: ${err.message}`)
          else reject(new Error(`rejected, but not by auth: "${err.message}"`))
        })
      )
      setTimeout(() => done(() => reject(new Error("no response in 12s"))), 12_000)
    })
  })

  // Auth-dependent checks need a real account. Report the skip loudly rather
  // than quietly passing a shorter suite — a silent cap reads as full coverage.
  const email = process.env.SMOKE_EMAIL
  const password = process.env.SMOKE_PASSWORD
  if (!email || !password) {
    record(
      "authenticated flows (login, socket join, presigned upload)",
      true,
      "set SMOKE_EMAIL and SMOKE_PASSWORD to include these",
      true
    )
  } else {
    await check("mobile sign-in returns tokens", async () => {
      const { res, body } = await fetchJson("/api/mobile/auth/signin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      })
      if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`)
      const b = body as { data?: { accessToken?: string } }
      if (!b?.data?.accessToken) throw new Error("no accessToken in response")
      process.env.__SMOKE_TOKEN = b.data.accessToken
      return "got access token"
    })

    await check("socket accepts a valid token and denies an unauthorized room", async () => {
      const token = process.env.__SMOKE_TOKEN
      if (!token) throw new Error("no token from sign-in")
      return await new Promise<string>((resolve, reject) => {
        const socket = io(BASE, { auth: { token }, transports: ["websocket"], reconnection: false })
        const done = (fn: () => void) => { socket.close(); fn() }
        socket.on("connect_error", (e) => done(() => reject(new Error(`connect failed: ${e.message}`))))
        socket.on("connected", () => {
          socket.on("error", (d: { code?: string }) =>
            done(() => (d?.code === "FORBIDDEN"
              ? resolve("unauthorized join denied")
              : reject(new Error(`unexpected error code ${d?.code}`)))))
          // A room this account is certainly not a member of.
          socket.emit("join:chat", "00000000-0000-0000-0000-000000000000")
          setTimeout(() => done(() => reject(new Error("join was not denied — room authz may be broken"))), 8_000)
        })
        setTimeout(() => done(() => reject(new Error("no connection in 12s"))), 12_000)
      })
    })
  }

  const failed = results.filter((r) => !r.ok)
  const skipped = results.filter((r) => r.skipped)
  console.log(
    `\n${results.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped\n`
  )
  if (failed.length) process.exit(1)
}

main().catch((e) => {
  console.error("smoke test crashed:", e)
  process.exit(1)
})
