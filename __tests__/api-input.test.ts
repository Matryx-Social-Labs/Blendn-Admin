import { isUuid, readJson, readOptionalJson } from "@/lib/api-input"

/*
 * What a caller sent, before a route trusts it (SCRUM-430, SCRUM-433, SCRUM-434).
 * The routes that use these are driven end to end by
 * `__tests__/integration/bad-input-never-500.itest.ts`; this pins the
 * semantics that no route there can reach on its own, such as an optional
 * body carrying a NUL.
 */
const post = (body?: string) => new Request("http://localhost/x", { method: "POST", body })

describe("readJson — a body the route requires", () => {
  it("is the parsed body", async () => {
    expect(await readJson(post('{"a":[1,"b"]}'))).toEqual({ a: [1, "b"] })
  })

  it.each([
    ["no body", undefined],
    ["a body that isn't JSON", '{"a":'],
    ["a NUL in a value", '{"reason":"a\\u0000b"}'],
    ["a NUL in a key", '{"a\\u0000":1}'],
    ["a NUL deep in an array", '{"ids":[["x","\\u0000"]]}'],
  ])("is undefined for %s", async (_, body) => {
    expect(await readJson(post(body))).toBeUndefined()
  })
})

describe("readOptionalJson — a body the route can do without", () => {
  it.each([
    ["no body", undefined],
    ["only whitespace", "  \n"],
  ])("is {} for %s", async (_, body) => {
    expect(await readOptionalJson(post(body))).toEqual({})
  })

  it("is the parsed body", async () => {
    expect(await readOptionalJson(post('{"ask":true}'))).toEqual({ ask: true })
  })

  it.each([
    ["a truncated body", '{"ask":true'],
    ["a NUL in a value", '{"message":"a\\u0000b"}'],
  ])("is undefined for %s, never the default", async (_, body) => {
    expect(await readOptionalJson(post(body))).toBeUndefined()
  })
})

describe("isUuid", () => {
  it.each(["00000000-0000-4000-8000-000000000000", "9772CC15-902A-458E-9EEB-5893807AD04D"])("accepts %s", (id) => {
    expect(isUuid(id)).toBe(true)
  })

  it.each(["not-a-uuid", "null", "", "9772cc15-902a-458e-9eeb-5893807ad04d\n", "😀", 12])("refuses %p", (id) => {
    expect(isUuid(id)).toBe(false)
  })
})
