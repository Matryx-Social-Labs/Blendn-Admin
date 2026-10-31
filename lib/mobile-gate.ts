/*
 * What `middleware.ts` refuses on every mobile request before a route runs
 * (Flow 15): a build the server no longer serves, and planned downtime.
 *
 * Pure, with the environment passed in, because the middleware runs on the
 * Edge (no Redis, no database, nothing imported from the app) and because a
 * rule that reads `process.env` itself can only be tested by mutating it.
 *
 * Both are off until an operator sets a variable, and both fail open: a
 * refusal nobody can see the reason for is a worse outage than the one it was
 * meant to announce.
 */

export const UPDATE_REQUIRED_CODE = "UPDATE_REQUIRED"
export const MAINTENANCE_CODE = "MAINTENANCE"

/** `Retry-After` when `MAINTENANCE_MODE` is on and no wait was configured. */
export const DEFAULT_MAINTENANCE_RETRY_SECONDS = 300
/** A typo of an extra zero must not tell every phone to stay away for a day. */
const MAX_MAINTENANCE_RETRY_SECONDS = 3600

export interface MobileGateEnv {
  MOBILE_MIN_APP_VERSION?: string
  MAINTENANCE_MODE?: string
  MAINTENANCE_RETRY_AFTER_SECONDS?: string
  /** The lowest store build number still served, per platform (SCRUM-851). Unset: no gate. */
  MOBILE_MIN_APP_BUILD_IOS?: string
  MOBILE_MIN_APP_BUILD_ANDROID?: string
}

/** What the request says about the build: `X-App-Build`, and the platform it runs on. */
export interface MobileBuild {
  build: string | null
  platform: string | null
  userAgent: string | null
}

export interface MobileGateRefusal {
  status: 426 | 503
  body: { success: false; error: string; errorCode: string; retryAfter?: number }
  headers: Record<string, string>
}

const VERSION = /^\d+(\.\d+){0,3}$/

/** "1.2.3" as [1, 2, 3, 0], or null for anything that is not a plain dotted number ("unknown", "1.0.0-beta", ""). */
export function parseAppVersion(raw: string | null | undefined): number[] | null {
  const text = raw?.trim()
  if (!text || !VERSION.test(text)) return null
  const parts = text.split(".").map(Number)
  if (parts.some((part) => !Number.isSafeInteger(part))) return null
  while (parts.length < 4) parts.push(0)
  return parts
}

/** Negative when `a` is older than `b`; both from `parseAppVersion`. */
function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

const warned = new Set<string>()
/** A misconfigured variable is logged once per value, not once per request. */
function warnOnce(message: string): void {
  if (warned.has(message)) return
  warned.add(message)
  console.warn(`[mobile-gate] ${message}`)
}

const MAINTENANCE_OFF = new Set(["0", "false", "no", "off"])

function maintenanceRefusal(env: MobileGateEnv): MobileGateRefusal | null {
  const mode = env.MAINTENANCE_MODE?.trim().toLowerCase()
  if (mode !== "1" && mode !== "true") {
    // A typo (`yes`, `on`) must not look like "off" without a word: the operator who set it wanted downtime.
    if (mode && !MAINTENANCE_OFF.has(mode)) {
      warnOnce(`MAINTENANCE_MODE="${env.MAINTENANCE_MODE}" is not 1 or true; maintenance is off`)
    }
    return null
  }

  const configured = Number(env.MAINTENANCE_RETRY_AFTER_SECONDS)
  const retryAfter =
    Number.isInteger(configured) && configured > 0
      ? Math.min(configured, MAX_MAINTENANCE_RETRY_SECONDS)
      : DEFAULT_MAINTENANCE_RETRY_SECONDS
  return {
    status: 503,
    body: {
      success: false,
      error: "Blendn is down for maintenance. Try again shortly.",
      errorCode: MAINTENANCE_CODE,
      retryAfter,
    },
    headers: { "Retry-After": String(retryAfter) },
  }
}

/**
 * Refused only when the build named itself, the name is a plain version, and
 * it is below the minimum. A missing header (every installed build, and the
 * web), `unknown` (a preview) or an unparsable one is never refused: the one
 * thing worse than a stale build is a gate that locks out a build that cannot
 * say what it is.
 */
function updateRefusal(appVersionHeader: string | null, env: MobileGateEnv): MobileGateRefusal | null {
  const configured = env.MOBILE_MIN_APP_VERSION?.trim()
  if (!configured) return null
  const minimum = parseAppVersion(configured)
  if (!minimum) {
    warnOnce(`MOBILE_MIN_APP_VERSION="${configured}" is not a version; no minimum is enforced`)
    return null
  }
  const sent = parseAppVersion(appVersionHeader)
  if (!sent || compareVersions(sent, minimum) >= 0) return null
  return {
    status: 426,
    body: {
      success: false,
      error: "This version of Blendn is no longer supported. Update the app to continue.",
      errorCode: UPDATE_REQUIRED_CODE,
    },
    headers: {},
  }
}

/** `ios` or `android` from `X-App-Platform`, else from the user agent of a native client; null when it cannot be told. */
function platformOf({ platform, userAgent }: MobileBuild): "ios" | "android" | null {
  const named = platform?.trim().toLowerCase()
  if (named === "ios" || named === "android") return named
  if (/okhttp|android/i.test(userAgent ?? "")) return "android"
  if (/cfnetwork|darwin|iphone|ios/i.test(userAgent ?? "")) return "ios"
  return null
}

/**
 * A build number below the platform's minimum. Same fail-open rule as the
 * version gate: no `X-App-Build` (every installed build, the web), a build
 * that is not a plain integer, an unknown platform or an unset/invalid minimum
 * is never refused. TestFlight builds all say 1.0.0, so this is the one that
 * can retire a single broken build (SCRUM-851).
 */
function buildRefusal(sent: MobileBuild, env: MobileGateEnv): MobileGateRefusal | null {
  if (!sent.build || !/^\d{1,9}$/.test(sent.build.trim())) return null
  const platform = platformOf(sent)
  if (!platform) return null
  const key = platform === "ios" ? "MOBILE_MIN_APP_BUILD_IOS" : "MOBILE_MIN_APP_BUILD_ANDROID"
  const configured = env[key]?.trim()
  if (!configured) return null
  if (!/^\d{1,9}$/.test(configured)) {
    warnOnce(`${key}="${configured}" is not a build number; no minimum is enforced`)
    return null
  }
  if (Number(sent.build) >= Number(configured)) return null
  return {
    status: 426,
    body: {
      success: false,
      error: "This version of Blendn is no longer supported. Update the app to continue.",
      errorCode: UPDATE_REQUIRED_CODE,
    },
    headers: {},
  }
}

/**
 * The first app build that sends `size` with a presigned-upload request
 * (client 1.0.0 + one patch). From here the mobile route requires it; older
 * builds keep an unbound URL until `MOBILE_MIN_APP_VERSION` passes them (API M6).
 * Keep in step with the client's app.json `version` when it ships `size`.
 */
export const UPLOAD_SIZE_REQUIRED_FROM_VERSION = "1.0.1"

/** True when the `X-App-Version` header names a build at or past the one that sends upload sizes. */
export function sendsUploadSize(appVersionHeader: string | null | undefined): boolean {
  const sent = parseAppVersion(appVersionHeader)
  const from = parseAppVersion(UPLOAD_SIZE_REQUIRED_FROM_VERSION)
  return Boolean(sent && from && compareVersions(sent, from) >= 0)
}

/** True once MOBILE_MIN_APP_VERSION is at or past `version`: every supported build has what that version shipped. */
export function minimumAtLeast(version: string, configured: string | undefined = process.env.MOBILE_MIN_APP_VERSION): boolean {
  const minimum = parseAppVersion(configured?.trim())
  const from = parseAppVersion(version)
  return Boolean(minimum && from && compareVersions(minimum, from) >= 0)
}

/** Maintenance first: while the server is down, "update the app" would be the wrong thing to say. */
export function mobileGateRefusal(
  appVersionHeader: string | null,
  env: MobileGateEnv,
  build: MobileBuild = { build: null, platform: null, userAgent: null }
): MobileGateRefusal | null {
  return maintenanceRefusal(env) ?? updateRefusal(appVersionHeader, env) ?? buildRefusal(build, env)
}
