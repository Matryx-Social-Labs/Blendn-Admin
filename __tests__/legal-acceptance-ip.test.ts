jest.mock("@/lib/db", () => ({ db: {} }))

import { truncatedIp } from "@/lib/legal-acceptance"

/**
 * An acceptance keeps the network a click came from, never the address
 * (SCRUM-1010, security M1). CHECK `legal_acceptances_ip_truncated` holds the
 * database to the same two shapes.
 */
describe("truncatedIp", () => {
  it.each([
    ["203.0.113.7", "203.0.113.0/24"],
    [" 10.1.2.254 ", "10.1.2.0/24"],
    ["2001:db8:85a3:8d3:1319:8a2e:370:7348", "2001:db8:85a3::/48"],
    ["2001:0DB8:0000:0042::1", "2001:db8:0::/48"],
    ["2001:db8::1", "2001:db8:0::/48"],
    ["::1", "0:0:0::/48"],
    ["fe80::1%en0", "fe80:0:0::/48"],
    ["::ffff:198.51.100.23", "198.51.100.0/24"],
    ["64:ff9b::192.0.2.33", "64:ff9b:0::/48"],
  ])("%s is kept as %s", (ip, network) => {
    expect(truncatedIp(ip)).toBe(network)
  })

  it.each([null, undefined, "", "not-an-ip; DROP TABLE", "203.0.113", "203.0.113.0/24", "2001:db8::/48"])("%p is nothing", (ip) => {
    expect(truncatedIp(ip)).toBeNull()
  })

  it("matches the CHECK's shapes", () => {
    for (const ip of ["203.0.113.7", "2001:db8:85a3:8d3:1319:8a2e:370:7348", "::1"]) {
      expect(truncatedIp(ip)).toMatch(/^(([0-9]{1,3}\.){3}0\/24|[0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f]{1,4}::\/48)$/)
    }
  })
})
