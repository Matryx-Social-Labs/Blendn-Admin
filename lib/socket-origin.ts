/**
 * Whether a socket handshake may proceed. A browser always sends `Origin` and
 * the native app never does; a page may open the socket from the allow-list or
 * from the host it is served by, and from nowhere else.
 */
export function socketOriginAllowed(origin: string | undefined, host: string | undefined, allowed: readonly string[]): boolean {
  if (!origin || allowed.includes(origin)) return true
  try {
    return !!host && new URL(origin).host === host
  } catch {
    return false
  }
}
