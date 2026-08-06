/**
 * Where a post-sign-in redirect may point.
 *
 * `/login?callbackUrl=…` exists so an invite link returns where it started.
 * Passing that value straight to `router.push()` is an **open redirect**: a
 * crafted invite could bounce someone to a look-alike sign-in on another host,
 * arriving from the real one, having just typed their password. That is the
 * most convincing phishing context there is, and the parameter is
 * attacker-supplied by construction — the whole point is that a link somewhere
 * else fills it in.
 *
 * Only same-origin absolute paths are allowed. Everything else falls back.
 *
 * Pinned by __tests__/safe-redirect.test.ts.
 */
export function safeRedirect(target: string | null | undefined, fallback = "/dashboard"): string {
  if (!target) return fallback

  // Must be an absolute path on this origin.
  if (!target.startsWith("/")) return fallback

  // `//evil.app` is protocol-relative — the browser reads it as a *host*, not a
  // path, so a naive `startsWith("/")` check waves it straight through. This is
  // the form that gets forgotten.
  if (target.startsWith("//")) return fallback

  // Some browsers normalise `/\` to `//`, giving the same escape.
  if (target.startsWith("/\\")) return fallback

  // Control characters and spaces are stripped while the browser parses a URL,
  // so the string that passes validation is not the string that gets navigated
  // to: "/\tjavascript:alert(1)" validates as a path and executes as a scheme.
  // Written as escapes, not literal characters: a literal tab or newline in a
  // character class is invisible in review and does not survive a formatter.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020]/.test(target)) return fallback

  return target
}
