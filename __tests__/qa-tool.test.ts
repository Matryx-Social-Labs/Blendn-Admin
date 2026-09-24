import { apiRefusal, probeArgs, secondsLeft, STAGING_API } from "../scripts/qa"

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

/*
 * A probe proves negative delivery: the banned socket does NOT hear the next
 * message. That is only true if the next message was posted. `npm run -s qa
 * probe … --post-as rohan@ hi` hands the script `… rohan@ hi` — npm 11 keeps
 * `--post-as` as its own config flag — and the parse used to run a listen-only
 * probe on that without a word, so "heard nothing" passed whether or not the
 * ban evicted anyone (SCRUM-284). Anything the parse would ignore is refused.
 */
describe("probe arguments", () => {
  const G = "beddb804-bbcf-4a49-97b1-8d86f763fea2"

  it("refuses what npm leaves of `--post-as`, rather than listening only", () => {
    expect(() => probeArgs([G, "fixture@blendn.app", "8", "rohan.d@blendn.app", "hello", "room"])).toThrow(/post-as/)
    expect(() => probeArgs([G, "fixture@blendn.app", "rohan.d@blendn.app", "hello"])).toThrow(/post-as/)
  })

  it("posts with the bare keyword npm passes through, and with the flag when npm is bypassed", () => {
    expect(probeArgs([G, "fixture@blendn.app", "8", "post-as", "rohan.d@blendn.app", "hello", "room"])).toEqual({
      groupId: G,
      email: "fixture@blendn.app",
      seconds: 8,
      postAs: "rohan.d@blendn.app",
      text: "hello room",
    })
    expect(probeArgs([G, "fixture@blendn.app", "--post-as", "rohan.d@blendn.app", "hi"])).toMatchObject({
      postAs: "rohan.d@blendn.app",
      text: "hi",
    })
  })

  it("listens for the default when no seconds are given, never for NaN", () => {
    // `Number("--post-as")` was NaN: the socket closed the moment it posted,
    // before anything could arrive — the same false "heard nothing".
    expect(probeArgs([G, "fixture@blendn.app", "post-as", "rohan.d@blendn.app", "hi"]).seconds).toBe(20)
    expect(probeArgs([G, "fixture@blendn.app"])).toEqual({ groupId: G, email: "fixture@blendn.app", seconds: 20 })
  })

  it("refuses a post with no poster or no text, and a probe with no one to probe as", () => {
    expect(() => probeArgs([G, "fixture@blendn.app", "8", "post-as", "hi"])).toThrow(/post-as/)
    expect(() => probeArgs([G, "fixture@blendn.app", "8", "post-as", "rohan.d@blendn.app"])).toThrow(/post-as/)
    expect(() => probeArgs([G])).toThrow(/usage/)
  })
})
