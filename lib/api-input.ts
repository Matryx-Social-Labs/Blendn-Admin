/**
 * What a caller sent, checked before it reaches the database.
 *
 * An id that cannot be a row and a body that is not JSON are both the caller's
 * mistake. Unchecked, Postgres refuses the uuid cast and `request.json()`
 * throws, and a route's catch-all reports either as a 500 — logged at ERROR
 * beside the real outages (SCRUM-430, SCRUM-433).
 * `__tests__/integration/bad-input-never-500.itest.ts` drives every route.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value)

/**
 * Postgres text cannot hold \u0000, so a body carrying one anywhere (a value or
 * a key, at any depth) is refused like one that isn't JSON (SCRUM-434).
 */
const hasNul = (value: unknown): boolean =>
  typeof value === "string"
    ? value.includes("\0")
    : typeof value === "object" && value !== null
      ? Object.entries(value).some(([key, v]) => key.includes("\0") || hasNul(v))
      : false

const refuseNul = (value: unknown): unknown => (hasNul(value) ? undefined : value)

/**
 * The request body, or `undefined` when it isn't JSON, so the route's schema
 * refuses it with a 400. For a body the route requires; see `readOptionalJson`.
 */
export const readJson = (request: Request): Promise<unknown> =>
  request.json().then(refuseNul, () => undefined)

/**
 * For a route whose body is optional: `{}` when there is none, and `undefined`
 * when there is one that isn't JSON. `request.json().catch(() => ({}))` made the
 * two the same, so a truncated `{"ask":true` got the default answer — and a
 * reveal's default is revealing yourself.
 */
export async function readOptionalJson(request: Request): Promise<unknown> {
  const raw = await request.text()
  if (!raw.trim()) return {}
  try {
    return refuseNul(JSON.parse(raw))
  } catch {
    return undefined
  }
}
