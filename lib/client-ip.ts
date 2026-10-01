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

/**
 * The network a client controls, for limiters on unauthenticated writes.
 *
 * An IPv6 client is handed a whole /64 by its provider and can use a fresh
 * address for every request, so keying a limit on the full address gives it a
 * fresh bucket each time. The /64 is the unit it actually holds. IPv4, and an
 * IPv4-mapped IPv6 address, key on the address. Not for the audit log, which
 * records the address itself (`clientIpFrom`).
 */
export function clientNetworkFrom(headers: { get(name: string): string | null }): string {
  const ip = clientIpFrom(headers)
  if (!ip.includes(":")) return ip
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip)
  if (mapped) return mapped[1]!
  const [head, tail] = ip.toLowerCase().split("%")[0]!.split("::")
  const left = head ? head.split(":") : []
  const right = tail !== undefined && tail !== "" ? tail.split(":") : []
  const missing = tail === undefined ? 0 : 8 - left.length - right.length
  const groups = [...left, ...Array(Math.max(missing, 0)).fill("0"), ...right]
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return ip
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`
}
