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
