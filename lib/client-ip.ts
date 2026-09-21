/**
 * The client's address, for rate-limit keys and the audit log.
 *
 * Measured on Railway's edge, 2026-09-21 (SCRUM-195), by logging the raw
 * headers of three probes from 91.9.218.44:
 *
 *   plain                      x-forwarded-for="91.9.218.44, 152.233.13.166"  x-real-ip="91.9.218.44"
 *   X-Forwarded-For: 203.0.113.9   x-forwarded-for="91.9.218.44, 152.233.12.242"  x-real-ip="91.9.218.44"
 *   X-Real-IP: 203.0.113.9 (+Envoy, +CF)  x-real-ip="91.9.218.44"; x-envoy-external-address and cf-connecting-ip arrived AS SENT
 *
 * So: `x-real-ip` is set by the edge and a client-sent one is overwritten;
 * `x-forwarded-for` is `<client>, <edge>` with a client-sent value stripped;
 * `x-envoy-external-address` and `cf-connecting-ip` pass straight through and
 * must never be read. The previous reader took the LAST forwarded hop, which
 * is Railway's own edge node — every per-network limit was one bucket per
 * edge node, shared by everyone behind it, and the audit log recorded the
 * edge. The comment that justified last-hop ("a client-sent header got a
 * fresh bucket on the first entry") was written against a proxy that does not
 * strip; Railway's does, and `x-real-ip` sidesteps the question anyway.
 *
 * "unknown" last, which fails toward refusing rather than toward letting
 * through.
 */
export function clientIpFrom(headers: { get(name: string): string | null }): string {
  const real = headers.get("x-real-ip")?.trim()
  if (real) return real

  const forwarded = headers.get("x-forwarded-for")
  if (forwarded) {
    const hops = forwarded.split(",").map((s) => s.trim()).filter(Boolean)
    if (hops.length) return hops[0]!
  }
  return "unknown"
}
