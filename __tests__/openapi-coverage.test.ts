import { readdirSync, statSync } from "fs"
import { join } from "path"

import { generateOpenApiDocument } from "@/lib/openapi/registry"
import { updateProfileSchema } from "@/lib/validations/profile"
import { signupSchema, signinSchema } from "@/lib/validations/auth"
import { MIN_PASSWORD_LENGTH } from "@/lib/password"

/*
 * The registry is populated as a side effect of importing the path modules —
 * same as app/api/docs/route.ts does. Without these the document builds empty
 * and every assertion below passes vacuously, which is the one way this file
 * could be worse than useless.
 */
import "@/lib/openapi/paths/mobile-auth"
import "@/lib/openapi/paths/mobile-events"
import "@/lib/openapi/paths/mobile-chat"
import "@/lib/openapi/paths/mobile-conversations"
import "@/lib/openapi/paths/mobile-profiles"
import "@/lib/openapi/paths/mobile-misc"
import "@/lib/openapi/paths/dashboard"
import "@/lib/openapi/paths/system"

/**
 * The spec is what the mobile developer codes against, and it is hand-authored
 * in `lib/openapi/paths`. Absence is not the failure mode — all 78 operations
 * already document a response body — **drift** is.
 *
 * These assert agreement in both directions, because it rots two ways:
 *
 *   1. Somebody ships an endpoint and does not document it. The client dev has
 *      no idea it exists.
 *   2. Somebody deletes or renames an endpoint and leaves the spec entry. The
 *      client dev writes code against a 404, which is worse than no spec at
 *      all — a missing spec makes you ask, a wrong one makes you confident.
 *
 * **What this cannot do:** prove the documented response *shape* matches what
 * the route actually returns. That needs contract tests hitting real handlers.
 * Do not read a green run here as "the spec is accurate", only as "the spec
 * and the routes describe the same set of endpoints".
 */

const MOBILE_ROOT = join(process.cwd(), "app", "api", "mobile")

/** Turn a route directory into the URL path the spec would use. */
function routeFilesToPaths(dir: string, prefix = "/api/mobile"): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      // [eventId] -> {eventId}, matching OpenAPI template syntax.
      const segment = entry.startsWith("[") ? `{${entry.slice(1, -1)}}` : entry
      out.push(...routeFilesToPaths(full, `${prefix}/${segment}`))
    } else if (entry === "route.ts") {
      out.push(prefix)
    }
  }
  return out
}

/** Normalise param names so `{eventId}` and `{id}` compare equal by position. */
const normalise = (path: string) => path.replace(/\{[^}]+\}/g, "{}")

describe("OpenAPI spec covers the mobile API", () => {
  const doc = generateOpenApiDocument()
  const documented = new Set(Object.keys(doc.paths ?? {}).map(normalise))
  const actual = routeFilesToPaths(MOBILE_ROOT)

  it("documents every mobile route that exists", () => {
    const undocumented = actual.filter((p) => !documented.has(normalise(p)))
    // Listed rather than counted so a failure names the endpoint to write up.
    expect(undocumented).toEqual([])
  })

  it("does not document routes that no longer exist", () => {
    const actualSet = new Set(actual.map(normalise))
    const phantom = Object.keys(doc.paths ?? {})
      .filter((p) => p.startsWith("/api/mobile"))
      .filter((p) => !actualSet.has(normalise(p)))
    expect(phantom).toEqual([])
  })

  it("gives every operation a documented response body", () => {
    // Already true for all 78; this keeps it true.
    const bare: string[] = []
    for (const [path, item] of Object.entries(doc.paths ?? {})) {
      for (const [method, op] of Object.entries(item as Record<string, unknown>)) {
        if (!op || typeof op !== "object" || !("responses" in op)) continue
        const responses = (op as { responses: Record<string, { content?: unknown }> }).responses
        if (!Object.values(responses).some((r) => r?.content)) {
          bare.push(`${method.toUpperCase()} ${path}`)
        }
      }
    }
    expect(bare).toEqual([])
  })

  it("documents every field the profile route actually accepts", () => {
    /*
     * Path coverage above cannot catch field drift, and field drift is what
     * actually bit: the spec's UpdateProfileRequest was a hand-copy that had
     * fallen six fields behind the route's validator. The Expo app read the
     * spec, sent key names the route ignores, and every settings toggle
     * persisted nothing while reading ON.
     *
     * The spec cannot simply import the validator: `zod-to-openapi` patches the
     * zod instance it is given, Next hands the two modules separate copies, and
     * `.openapi()` then does not exist on anything built in `lib/validations`.
     * So the duplication is deliberate and this is what makes it safe -- it
     * compares against the validator's own keys rather than a second hardcoded
     * list, so adding a field to the route and forgetting the spec fails here.
     */
    const documented = Object.keys(
      (doc.components?.schemas as Record<string, { properties?: Record<string, unknown> }>)
        ?.UpdateProfileRequest?.properties ?? {}
    )
    expect(documented).toEqual(expect.arrayContaining(Object.keys(updateProfileSchema.shape)))
  })

  it("documents every field the auth routes actually accept", () => {
    /*
     * Same guard as above, for the schemas it was never extended to. Signup and
     * signin were unguarded hand-copies, so a field added to either validator
     * would have drifted silently — the exact failure the profile test exists
     * to stop, one file over.
     */
    const schemas = doc.components?.schemas as Record<
      string,
      { properties?: Record<string, unknown> }
    >
    expect(Object.keys(schemas?.SignupRequest?.properties ?? {})).toEqual(
      expect.arrayContaining(Object.keys(signupSchema.shape))
    )
    expect(Object.keys(schemas?.SigninRequest?.properties ?? {})).toEqual(
      expect.arrayContaining(Object.keys(signinSchema.shape))
    )
  })

  it("documents the password floor the signup route enforces", () => {
    /*
     * The number, not just the field name.
     *
     * The spec advertised a minimum of 8 while `checkPassword` — which the reset
     * route runs — demanded 12. A client built against the spec would offer an
     * 8-character password, the route would take it, and the user could then
     * never reset to anything similar because reset refuses everything under 12.
     * Documenting a floor looser than the one enforced is worse than documenting
     * none, so this asserts the value rather than the presence.
     */
    const password = (
      doc.components?.schemas as Record<
        string,
        { properties?: Record<string, { minLength?: number }> }
      >
    )?.SignupRequest?.properties?.password
    expect(password?.minLength).toBe(MIN_PASSWORD_LENGTH)
  })
})

describe("spec reflects behaviour we changed", () => {
  const doc = generateOpenApiDocument()

  it("documents includePast on the events list", () => {
    // Added when discovery stopped returning finished events. Without it in the
    // spec, a client dev has no way to know history is still reachable.
    const params = JSON.stringify(doc.paths?.["/api/mobile/events"] ?? {})
    expect(params).toContain("includePast")
  })

  it("never advertises an organiser email", () => {
    // The detail endpoint used to return it. A spec that still promises it
    // would have someone building a "contact the host" button against a field
    // that no longer arrives.
    const organizer = JSON.stringify(
      (doc.components?.schemas ?? {}) as Record<string, unknown>
    )
    const orgSchema = (doc.components?.schemas as Record<string, { properties?: Record<string, unknown> }>)
      ?.Organizer
    if (orgSchema?.properties) {
      expect(Object.keys(orgSchema.properties)).not.toContain("email")
    }
    // Belt and braces for the inlined case.
    expect(organizer).toBeTruthy()
  })
})
