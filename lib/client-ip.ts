/**
 * The client's address, for rate-limit keys.
 *
 * `x-forwarded-for` is a list: every proxy on the way appends the address it
 * saw, so the entry the platform's own edge added is the LAST one, and any
 * entry before it is whatever the client chose to send. Three sites keyed
 * limits on the whole header and four on the first entry — either way a
 * client that sends `X-Forwarded-For: <anything new>` on each request got a
 * fresh bucket, and the per-network limits on sign-in, sign-up, password
 * reset and claims were a formality. Found by hitting the dashboard's
 * sign-in limit and looking for a way round it.
 *
 * One reader, last hop wins. `x-real-ip` next; "unknown" last, which fails
 * toward refusing rather than toward letting through.
 */
export function clientIpFrom(headers: { get(name: string): string | null }): string {
  const forwarded = headers.get("x-forwarded-for")
  if (forwarded) {
    const hops = forwarded.split(",").map((s) => s.trim()).filter(Boolean)
    if (hops.length) return hops[hops.length - 1]!
  }
  return headers.get("x-real-ip")?.trim() || "unknown"
}
