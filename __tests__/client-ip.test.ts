import { clientIpFrom } from "@/lib/client-ip"

/*
 * A client that sends its own X-Forwarded-For must not get a fresh rate-limit
 * bucket. The proxy appends the address it saw, so the trustworthy entry is
 * the last one; three limiters keyed on the whole header and four on the
 * first entry, and both let a rotating header round every per-network limit.
 */
const h = (m: Record<string, string>) => ({ get: (n: string) => m[n.toLowerCase()] ?? null })

it("takes the last hop, which is the one the edge appended", () => {
  expect(clientIpFrom(h({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" }))).toBe("203.0.113.9")
  expect(clientIpFrom(h({ "x-forwarded-for": " spoofed , 10.9.8.7 , 203.0.113.9 " }))).toBe("203.0.113.9")
})

it("a spoofed first hop does not change the key", () => {
  const real = clientIpFrom(h({ "x-forwarded-for": "203.0.113.9" }))
  expect(clientIpFrom(h({ "x-forwarded-for": "9.9.9.9, 203.0.113.9" }))).toBe(real)
})

it("falls back to x-real-ip, then to a shared bucket", () => {
  expect(clientIpFrom(h({ "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4")
  expect(clientIpFrom(h({}))).toBe("unknown")
  expect(clientIpFrom(h({ "x-forwarded-for": " , " }))).toBe("unknown")
})
