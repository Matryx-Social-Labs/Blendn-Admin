import { apiRefusal, secondsLeft, STAGING_API } from "../scripts/qa"

/*
 * The testing programme's tool (docs/agents/TEST-PLAN.md) signs in, reads and
 * probes on behalf of every session. It must never point at production: a
 * cached token or a probe against api.blendn.app acts on real people.
 */
it("allows staging and a local server, and refuses production and anything else", () => {
  expect(apiRefusal(STAGING_API)).toBeNull()
  expect(apiRefusal("http://localhost:3100")).toBeNull()
  expect(apiRefusal("https://api.blendn.app")).toMatch(/neither staging nor local/)
  expect(apiRefusal("https://staging-api.blendn.app.evil.example")).toMatch(/neither staging nor local/)
  expect(apiRefusal("not a url")).toMatch(/unparseable/)
})

it("reads a token's remaining life from its exp claim", () => {
  const jwt = (exp: number) => `x.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.y`
  const now = Date.UTC(2026, 8, 24, 12)
  expect(secondsLeft(jwt(now / 1000 + 600), now)).toBeCloseTo(600)
  expect(secondsLeft(jwt(now / 1000 - 1), now)).toBeLessThan(0)
  expect(secondsLeft("garbage", now)).toBe(-1)
})
