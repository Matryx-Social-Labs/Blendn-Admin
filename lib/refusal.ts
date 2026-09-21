/**
 * The server's own words for a refusal, whatever shape it sent them in.
 *
 * The dashboard API is mid-migration from bare strings to `lib/api-response`'s
 * envelope, and both shapes are live at once. A consumer that assumes either
 * one breaks on the other:
 *
 *   - `await res.text()` on an envelope renders the literal JSON at the user —
 *     `{"success":false,"error":"Not found"}` in a toast.
 *   - `(await res.json()).error` on a bare string throws, and the catch usually
 *     swallows it into a generic message, which is how a route that returns
 *     seven distinct sentences ends up showing one.
 *
 * Reads both, so routes and consumers do not have to migrate in lockstep.
 *
 * The fallback matters as much as the parsing. `event-messaging.tsx` threw
 * `new Error(await refusal(res))` where `refusal` returned `""` for a bare
 * string, and the catch did `err.message` — so a 403 produced an **empty
 * toast**: the user saw a notification appear and say nothing.
 */
export async function refusalText(res: Response, fallback: string): Promise<string> {
  const body = await res.text().catch(() => "")
  if (!body) return fallback

  try {
    const parsed = JSON.parse(body)
    if (typeof parsed?.error === "string" && parsed.error) return parsed.error
    // An envelope whose error is structured, or a success body on a failed
    // status. Neither is something to show a person.
    if (parsed && typeof parsed === "object") return fallback
  } catch {
    // Not JSON: a bare string refusal, which is the thing being migrated away
    // from and is still the correct message to show while it exists.
  }

  // Guard against a stray HTML error page reaching a toast.
  if (/^\s*</.test(body)) return fallback
  return body.trim() || fallback
}

/* -------------------------------------------------------------------------- */
/* Refusals thrown by server actions                                           */
/* -------------------------------------------------------------------------- */

const REFUSAL_DIGEST = "refusal:"

/**
 * A refusal a server action throws that must reach the screen in production.
 *
 * Next.js replaces the message of any error thrown inside a server action
 * before it crosses to the browser in production — the client receives
 * "An error occurred in the Server Components render. The specific message is
 * omitted…", which Sonner rendered as "Minified React error #441". Every
 * `throw new Error("This is the last owner. Promote someone else first.")`
 * in the dashboard's actions therefore read as that sentence on staging and
 * production, while dev showed the real one — which is how ninety refusals
 * were written, driven locally, and never seen by an operator (SCRUM-139).
 *
 * What does cross is `error.digest`: Next's error handler respects a digest
 * that is already set ("If the error already has a digest, respect the
 * original digest" — `next/dist/server/app-render/create-error-handler.js`),
 * and React Flight sends exactly that field. So the sentence rides in the
 * digest, and `refusalMessage` reads it back on the client. Deliberately not
 * the return-shape migration (`{ ok: false, message }`): that is the sanctioned
 * pattern, and `inviteMember` uses it, but it changes the control flow at every
 * caller, whereas this changes one word at the throw and one word at the
 * catch. Move to return shapes action by action when a caller is rewritten
 * anyway; the guard in `__tests__/refusal-reaches-the-screen.test.ts` only
 * insists that no action throws a bare `Error` at a person.
 *
 * Nothing sensitive may be thrown this way: the digest is user-visible by
 * design. Every message in the actions is a sentence written for the operator.
 */
export class Refusal extends Error {
  readonly digest: string

  constructor(message: string) {
    super(message)
    this.name = "Refusal"
    this.digest = REFUSAL_DIGEST + message
  }
}

/**
 * The sentence a server action refused with, or the error's own message, or
 * the fallback.
 *
 * Reads the digest first because that is the one field that survives
 * production. An ordinary `Error` keeps its message — the client throws its
 * own (`throw new Error(await refusalText(res, …))`) and those were always
 * right — unless the message is the production mask itself, which is the one
 * sentence that must never reach a toast again.
 */
/**
 * A page open across a deploy holds the previous build's server-action ids.
 * Next answers the next submit with this, and the message it carries is a
 * documentation link — which a venue owner read verbatim in a toast, with a
 * traced fence still on screen and no way to send it (SCRUM-202).
 */
export const STALE_PAGE_MESSAGE =
  "The dashboard was updated while this page was open. Reload the page and try again."

function isStaleServerAction(message: string): boolean {
  return message.includes("failed-to-find-server-action") || message.includes("Failed to find Server Action")
}

export function refusalMessage(err: unknown, fallback: string): string {
  if (!err || typeof err !== "object") return fallback
  const digest = (err as { digest?: unknown }).digest
  if (typeof digest === "string" && digest.startsWith(REFUSAL_DIGEST)) {
    return digest.slice(REFUSAL_DIGEST.length) || fallback
  }
  if (err instanceof Error && err.message) {
    if (isStaleServerAction(err.message)) return STALE_PAGE_MESSAGE
    if (!isProductionMask(err.message)) return err.message
  }
  return fallback
}

/** What React and Next put in an error's message once the real one is stripped. */
function isProductionMask(message: string): boolean {
  return (
    message.startsWith("Minified React error #") ||
    message.includes("omitted in production") ||
    message.includes("Server Components render")
  )
}
