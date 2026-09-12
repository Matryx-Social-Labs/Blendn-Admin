import { clientIpFrom } from "@/lib/client-ip"
import { NextRequest, NextResponse } from "next/server"
import {
  RATE_LIMIT_WINDOW,
  RATE_LIMIT_MAX_REQUESTS,
} from "@/lib/constants"
import { ErrorCode } from "@/lib/api-response"
import { hit } from "@/lib/rate-limit-store"

interface RateLimitConfig {
  windowMs: number
  maxRequests: number
  keyGenerator?: (req: NextRequest) => string
}

const DEFAULT_KEY_GENERATOR = (req: NextRequest): string => {
  const ip = clientIpFrom(req.headers)
  return `${req.method}:${req.nextUrl.pathname}:${ip}`
}

/**
 * Rate limiter. Returns null if allowed, or a 429 if not.
 *
 * Async because the counter now lives in Redis when one is configured — the
 * previous version kept it in a process-local Map, so every limit was
 * per-replica and got weaker with each instance added.
 */
export async function rateLimit(
  req: NextRequest,
  config: RateLimitConfig
): Promise<NextResponse | null> {
  const { windowMs, maxRequests, keyGenerator = DEFAULT_KEY_GENERATOR } = config
  const key = `rl:${keyGenerator(req)}`

  const { count, resetAt } = await hit(key, windowMs)
  if (count <= maxRequests) return null

  const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))
  return NextResponse.json(
    /*
     * `errorCode` is not decoration. It is declared in the OpenAPI spec and in
     * `lib/api-response.ts` and was emitted by nothing, so every generated
     * client failed to decode a 429 across ~60 routes and fell through to a
     * generic error. The string body was already correct; only the machine
     * -readable half was missing.
     */
    { success: false, error: "Too many requests", errorCode: ErrorCode.RATE_LIMITED, retryAfter },
    {
      status: 429,
      headers: {
        "X-RateLimit-Limit": maxRequests.toString(),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": resetAt.toString(),
        "Retry-After": retryAfter.toString(),
      },
    }
  )
}

/**
 * Create a rate limit configuration for batch endpoints
 */
export function createBatchRateLimit(): RateLimitConfig {
  return {
    windowMs: RATE_LIMIT_WINDOW.BATCH,
    maxRequests: RATE_LIMIT_MAX_REQUESTS.BATCH,
  }
}

/**
 * Rate limit keyed on the authenticated user rather than the client IP.
 *
 * Use this for endpoints where the caller is already authenticated and the
 * abuse case is a single compromised or misbehaving account, not an anonymous
 * flood — IP keying is useless there because everyone behind one NAT shares a
 * bucket while the attacker just rotates addresses.
 */
export function createUserRateLimit(
  scope: "organiser-broadcast" | "private-message",
  userId: string
): RateLimitConfig {
  const settings = {
    "organiser-broadcast": {
      windowMs: RATE_LIMIT_WINDOW.ORGANISER_BROADCAST,
      maxRequests: RATE_LIMIT_MAX_REQUESTS.ORGANISER_BROADCAST,
    },
    "private-message": {
      windowMs: RATE_LIMIT_WINDOW.PRIVATE_MESSAGE,
      maxRequests: RATE_LIMIT_MAX_REQUESTS.PRIVATE_MESSAGE,
    },
  }[scope]

  return {
    ...settings,
    keyGenerator: () => `${scope}:${userId}`,
  }
}

/**
 * Create a rate limit configuration for auth endpoints
 */
export function createAuthRateLimit(
  type: "signin" | "signup" | "google" | "apple" | "refresh" | "dashboard-signin"
): RateLimitConfig {
  const configs: Record<string, RateLimitConfig> = {
    signin: {
      windowMs: RATE_LIMIT_WINDOW.SIGNIN,
      maxRequests: RATE_LIMIT_MAX_REQUESTS.SIGNIN,
      keyGenerator: (req) => {
        const ip = clientIpFrom(req.headers)
        /*
         * Per-IP only, and that is all this hook can be: `keyGenerator` is
         * synchronous and runs before the route reads the body, so the email
         * is not available here. The per-account limit lives in the signin
         * route itself, after parsing — see the second `rateLimit` call in
         * `app/api/mobile/auth/signin/route.ts`.
         */
        return `auth:signin:${ip}`
      },
    },
    signup: {
      windowMs: RATE_LIMIT_WINDOW.SIGNUP,
      maxRequests: RATE_LIMIT_MAX_REQUESTS.SIGNUP,
      keyGenerator: (req) => {
        const ip = clientIpFrom(req.headers)
        return `auth:signup:${ip}`
      },
    },
    google: {
      windowMs: RATE_LIMIT_WINDOW.GOOGLE_AUTH,
      maxRequests: RATE_LIMIT_MAX_REQUESTS.GOOGLE_AUTH,
      keyGenerator: (req) => {
        const ip = clientIpFrom(req.headers)
        return `auth:google:${ip}`
      },
    },
    apple: {
      windowMs: RATE_LIMIT_WINDOW.GOOGLE_AUTH,
      maxRequests: RATE_LIMIT_MAX_REQUESTS.GOOGLE_AUTH,
      keyGenerator: (req) => {
        const ip = clientIpFrom(req.headers)
        return `auth:apple:${ip}`
      },
    },
    refresh: {
      windowMs: RATE_LIMIT_WINDOW.REFRESH,
      maxRequests: RATE_LIMIT_MAX_REQUESTS.REFRESH,
      keyGenerator: (req) => {
        const ip = clientIpFrom(req.headers)
        return `auth:refresh:${ip}`
      },
    },
    "dashboard-signin": {
      windowMs: RATE_LIMIT_WINDOW.DASHBOARD_SIGNIN,
      maxRequests: RATE_LIMIT_MAX_REQUESTS.DASHBOARD_SIGNIN,
      keyGenerator: (req) => {
        const ip = clientIpFrom(req.headers)
        return `auth:dashboard-signin:${ip}`
      },
    },
  }

  return configs[type]
}

/**
 * Per-user policies for authenticated mutations.
 *
 * Keyed on the user, not the IP: for an authenticated endpoint the abuse case
 * is one account misbehaving, and IP keying is actively wrong there — everyone
 * behind a single NAT shares a bucket while an attacker just rotates address.
 *
 * The numbers are chosen to be invisible to a person using the app normally and
 * to bite a script. `report` and `block` are deliberately generous: rate
 * limiting a safety action is a trade-off against someone in trouble, so the
 * limit is set where only automation notices it.
 */
const USER_POLICIES = {
  /** Sends a push to every attendee — the most expensive thing a host can do. */
  broadcast: { windowMs: 60 * 1000, maxRequests: 3 },
  /** Issues a signed upload URL; unbounded means unbounded storage. */
  upload: { windowMs: 60 * 1000, maxRequests: 20 },
  /** Safety actions. Loose on purpose — see above. */
  safety: { windowMs: 60 * 1000, maxRequests: 20 },
  /** Ordinary writes: RSVP, favourite, rating, interest, profile edits. */
  write: { windowMs: 60 * 1000, maxRequests: 30 },
  /** Creating or destroying whole objects. */
  heavy: { windowMs: 60 * 1000, maxRequests: 10 },
} as const

export type UserRateLimitPolicy = keyof typeof USER_POLICIES

/**
 * Rate limit an authenticated route, keyed on the caller.
 *
 * `scope` should be stable per endpoint — it namespaces the bucket so a user
 * hitting two different endpoints does not share one allowance.
 */
export function userLimit(
  policy: UserRateLimitPolicy,
  scope: string,
  userId: string
): RateLimitConfig {
  return {
    ...USER_POLICIES[policy],
    keyGenerator: () => `${scope}:${userId}`,
  }
}
