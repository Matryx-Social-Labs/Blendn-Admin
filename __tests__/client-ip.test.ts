import { clientIpFrom, clientNetworkFrom } from "@/lib/client-ip"

/*
 * What Railway's edge actually sends, measured (SCRUM-195): `x-real-ip` is the
 * client and cannot be set by the client; `x-forwarded-for` is
 * "<client>, <edge>" with a client-sent value stripped. The last hop is the
 * edge — reading it keyed every per-network limit on Railway's own node, one
 * bucket shared by everyone behind it, and wrote the edge into the audit log.
 */
const h = (m: Record<string, string>) => ({ get: (n: string) => m[n.toLowerCase()] ?? null })

it("prefers x-real-ip, which the edge sets and a client cannot", () => {
  expect(
    clientIpFrom(h({ "x-real-ip": "91.9.218.44", "x-forwarded-for": "91.9.218.44, 152.233.13.166" }))
  ).toBe("91.9.218.44")
})

it("otherwise takes the FIRST forwarded hop — the client — not the edge that follows it", () => {
  expect(clientIpFrom(h({ "x-forwarded-for": "91.9.218.44, 152.233.13.166" }))).toBe("91.9.218.44")
  expect(clientIpFrom(h({ "x-forwarded-for": " 91.9.218.44 , 152.233.12.242 " }))).toBe("91.9.218.44")
})

it("ignores headers the edge passes through untouched", () => {
  // Both arrived exactly as a curl sent them; either would hand a client a fresh bucket per request.
  expect(
    clientIpFrom(
      h({ "x-envoy-external-address": "203.0.113.9", "cf-connecting-ip": "203.0.113.9", "x-real-ip": "91.9.218.44" })
    )
  ).toBe("91.9.218.44")
})

it("shares one bucket when nothing identifies the client", () => {
  expect(clientIpFrom(h({}))).toBe("unknown")
  expect(clientIpFrom(h({ "x-forwarded-for": " , " }))).toBe("unknown")
})

describe("clientNetworkFrom — the bucket for an unauthenticated write", () => {
  it("keys an IPv6 client on its /64, so a fresh address is not a fresh bucket", () => {
    expect(clientNetworkFrom(h({ "x-real-ip": "2001:db8:85a3:12:8a2e:370:7334:1" }))).toBe("2001:db8:85a3:12::/64")
    expect(clientNetworkFrom(h({ "x-real-ip": "2001:db8:85a3:12::9" }))).toBe("2001:db8:85a3:12::/64")
    expect(clientNetworkFrom(h({ "x-real-ip": "2001:db8::1" }))).toBe("2001:db8:0:0::/64")
  })

  it("keys IPv4, and IPv4 written as IPv6, on the address", () => {
    expect(clientNetworkFrom(h({ "x-real-ip": "91.9.218.44" }))).toBe("91.9.218.44")
    expect(clientNetworkFrom(h({ "x-real-ip": "::ffff:91.9.218.44" }))).toBe("91.9.218.44")
  })

  it("leaves anything it cannot read as it was", () => {
    expect(clientNetworkFrom(h({}))).toBe("unknown")
    expect(clientNetworkFrom(h({ "x-real-ip": "not:an:address" }))).toBe("not:an:address")
  })
})
