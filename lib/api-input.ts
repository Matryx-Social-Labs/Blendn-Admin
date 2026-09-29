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
 * A JSON string can carry a NUL only as the escape `\u0000` (a raw NUL is not
 * valid JSON), and Postgres text cannot hold one, so a body with that escape is
 * refused like one that isn't JSON (SCRUM-434). Checked on the raw text before
 * parsing: linear, with nothing to recurse into on a deeply nested body. An
 * escaped backslash followed by `u0000` is literal text and passes.
 */
const NUL_ESCAPE = /(?<!\\)(?:\\\\)*\\u0000/

function parseBody(raw: string): unknown {
  if (NUL_ESCAPE.test(raw)) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/**
 * The request body, or `undefined` when it isn't JSON, so the route's schema
 * refuses it with a 400. For a body the route requires; see `readOptionalJson`.
 */
export const readJson = async (request: Request): Promise<unknown> =>
  parseBody(await request.text().catch(() => ""))

/**
 * For a route whose body is optional: `{}` when there is none, and `undefined`
 * when there is one that isn't JSON. `request.json().catch(() => ({}))` made the
 * two the same, so a truncated `{"ask":true` got the default answer — and a
 * reveal's default is revealing yourself.
 */
export async function readOptionalJson(request: Request): Promise<unknown> {
  const raw = await request.text()
  return raw.trim() ? parseBody(raw) : {}
}
