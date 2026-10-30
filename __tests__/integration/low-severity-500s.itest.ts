import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"

import { closeDb, db, makeUser, testId } from "./helpers"

/*
 * SCRUM-946: two inputs that answered 500. `sortBy=distance` with no
 * coordinates reached Prisma as `orderBy: { distance }` (not a column), and
 * `search?q=<` reached to_tsquery as an operator.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const listRoute = require("@/app/api/mobile/events/route") as typeof import("@/app/api/mobile/events/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const searchRoute = require("@/app/api/mobile/events/search/route") as typeof import("@/app/api/mobile/events/search/route")

let user = ""
let auth = ""

beforeAll(async () => {
  user = await makeUser(testId("lo_viewer"))
  await db.profiles.create({ data: { id: user, onboarded: true } })
  const { email } = await db.user.findUniqueOrThrow({ where: { id: user }, select: { email: true } })
  auth = signAccessToken(user, email)
})

afterAll(async () => {
  await db.profiles.deleteMany({ where: { id: user } })
  await db.user.deleteMany({ where: { id: user } })
  await closeDb()
})

const get = (route: { GET: (r: NextRequest) => Promise<Response> }, path: string) =>
  route.GET(new NextRequest(`http://localhost${path}`, { headers: { authorization: `Bearer ${auth}` } }))

describe("inputs that used to answer 500", () => {
  it("sortBy=distance without coordinates lists by start time", async () => {
    expect((await get(listRoute, "/api/mobile/events?sortBy=distance")).status).toBe(200)
  })

  it.each(["<", "<->", "a<b", "foo:bar", "!!", "(a"])("search q=%s answers 200", async (q) => {
    expect((await get(searchRoute, `/api/mobile/events/search?q=${encodeURIComponent(q)}`)).status).toBe(200)
  })
})
