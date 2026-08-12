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
 *
 * The authenticated half needs an account and, for the photo guard, the bucket
 * name for that environment:
 *
 *   BASE_URL=https://staging-api.blendn.app \
 *   SMOKE_EMAIL=… SMOKE_PASSWORD=… SMOKE_BUCKET=blendn-media-staging \
 *   npm run smoke
 *
 * Nothing here mutates anything a person would notice. The photo matrix is
 * rejected in full before the profile is touched, and `intent_default` is set
 * to a value the smoke account already holds.
 *
 * **Not covered here, deliberately, so the gap is visible rather than assumed:**
 *
 * - **Push delivery.** `push_enabled: false` suppressing a notification cannot
 *   be observed over HTTP at all. Unit-tested in `push-notifications.test.ts`;
 *   confirmed on a device in `docs/TESTING_CHECKLIST.md` §B.
 * - **The reveal and close lifecycle.** Both are one-way — you cannot un-reveal
 *   or re-open — so a suite that ran them would work once and then assert
 *   against its own leftovers. Covered by `__tests__/integration/*.itest.ts`,
 *   which run against a database that is rebuilt each time.
 * - **Block reaching the event room.** Needs group-chat state and a live
 *   socket; `block-reaches-the-room.test.ts` and the device checklist cover it.
 *
 * See `docs/VERIFICATION.md` for which tier owns which capability.
 */
import { io } from "socket.io-client"
import { assertDiscriminates } from "../lib/discriminates"

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

/** The user id, from the access token, without a second round trip. */
function userIdFromToken(token: string): string {
  const seg = token.split(".")[1]
  if (!seg) throw new Error("access token is not a JWT")
  const json = Buffer.from(seg.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
  const payload = JSON.parse(json) as { userId?: string; sub?: string }
  const id = payload.userId ?? payload.sub
  if (!id) throw new Error("no userId in token payload")
  return id
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

    const auth = () => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.__SMOKE_TOKEN}`,
    })

    /*
     * None of what follows mutates anything.
     *
     * `PUT /profiles/:id` rejects the whole request on the first bad photo, so
     * a matrix of rejected URLs leaves the profile exactly as it was — which is
     * what makes this safe to run against staging on every deploy.
     */
    await check("the photo guard discriminates, and says which half refused", async () => {
      const bucket = process.env.SMOKE_BUCKET
      if (!bucket) throw new Error("set SMOKE_BUCKET to the Tigris bucket for this environment")
      const uid = userIdFromToken(process.env.__SMOKE_TOKEN!)
      const host = `${bucket}.t3.storage.dev`

      /*
       * `not_ours` means the ownership check refused it. `too_small` means
       * ownership *passed* and the size check refused it — an object that is
       * not there reports `too_small`, which is precisely the acceptance
       * signal we need without uploading anything.
       */
      const cases: Array<{ label: string; url: string }> = [
        { label: "our bucket, our folder", url: `https://${host}/profile/${uid}/smoke-probe.jpg` },
        { label: "someone else's folder", url: `https://${host}/profile/not-${uid}/x.jpg` },
        { label: "chat folder (different trust class)", url: `https://${host}/chat/${uid}/x.jpg` },
        { label: "host ending with our bucket name", url: `https://evil-${host}/profile/${uid}/x.jpg` },
        { label: "http downgrade to our own bucket", url: `http://${host}/profile/${uid}/x.jpg` },
        { label: "path traversal", url: `https://${host}/profile/${uid}/../../etc/passwd` },
        { label: "cloud metadata endpoint", url: "http://169.254.169.254/latest/meta-data/" },
      ]

      const outcomes = await Promise.all(
        cases.map(async (c) => {
          const { body } = await fetchJson(`/api/mobile/profiles/${uid}`, {
            method: "PUT",
            headers: auth(),
            body: JSON.stringify({ photos: [c.url] }),
          })
          const code = (body as { errorCode?: string })?.errorCode
          // Accepted BY THE OWNERSHIP CHECK, which is the thing under test.
          return { label: c.label, accepted: code === "too_small", code }
        })
      )

      const detail = assertDiscriminates(outcomes)
      const control = outcomes.find((o) => o.label === "our bucket, our folder")
      if (!control?.accepted) {
        throw new Error(
          `the control failed (code=${control?.code}) — SMOKE_BUCKET is probably wrong ` +
            `for this environment, and every other refusal below is meaningless`
        )
      }
      return detail
    })

    await check("`just_here` is exclusive, server-side", async () => {
      const uid = userIdFromToken(process.env.__SMOKE_TOKEN!)
      const put = async (intent_default: string[]) => {
        const { res } = await fetchJson(`/api/mobile/profiles/${uid}`, {
          method: "PUT",
          headers: auth(),
          body: JSON.stringify({ intent_default }),
        })
        return res.status
      }

      // The positive control mutates one column to a value it very likely
      // already holds. Without it, a route that rejected *everything* would
      // read as a working rule.
      const outcomes = [
        { label: "networking alone", accepted: (await put(["networking"])) === 200 },
        {
          label: "all four intents at once",
          accepted: (await put(["dating", "networking", "friendship", "just_here"])) === 200,
        },
        {
          label: "just_here beside dating",
          accepted: (await put(["just_here", "dating"])) === 200,
        },
      ]
      return assertDiscriminates(outcomes)
    })

    await check("a conversation you are not in is invisible, not forbidden", async () => {
      // 404 rather than 403 on purpose: 403 confirms the row exists, which
      // tells an outsider that two specific people are talking.
      const ghost = "00000000-0000-0000-0000-000000000000"
      const outcomes: Array<{ label: string; accepted: boolean }> = []

      const list = await fetchJson("/api/mobile/conversations", { headers: auth() })
      outcomes.push({ label: "own conversation list", accepted: list.res.status === 200 })

      for (const [label, path] of [
        ["detail", `/api/mobile/conversations/${ghost}`],
        ["messages", `/api/mobile/conversations/${ghost}/messages`],
      ] as const) {
        const { res } = await fetchJson(path, { headers: auth() })
        if (res.status === 403) throw new Error(`${label} returned 403 — that confirms the row exists`)
        outcomes.push({ label, accepted: res.status === 200 })
      }

      return assertDiscriminates(outcomes)
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
