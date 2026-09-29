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
 * The request body, or `undefined` when it isn't JSON, so the route's schema
 * refuses it with a 400. For a body the route requires; see `readOptionalJson`.
 */
export const readJson = (request: Request): Promise<unknown> => request.json().catch(() => undefined)

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
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}
