/**
 * The blocklist an action writes is the one the mobile routes read
 * (lib/account-blocklist.ts, SCRUM-603).
 *
 * Next bundles a copy of the module per layer. Driven on staging: Settings
 * signed a phone out, and its access token still answered 200 at the API four
 * seconds later and 401 only at the route copy's next refresh, 29 s on. Two
 * copies are made here with `isolateModules`, and the database says nothing,
 * so only the shared state can carry what the action said.
 */
const mockFindMany = jest.fn()
jest.mock("@/lib/db", () => ({ db: { user: { findMany: (...args: unknown[]) => mockFindMany(...args) } } }))

type Blocklist = typeof import("@/lib/account-blocklist")

function aCopy(): Blocklist {
  let copy!: Blocklist
  jest.isolateModules(() => {
    copy = jest.requireActual("@/lib/account-blocklist")
  })
  return copy
}

const shared = globalThis as typeof globalThis & { __blendnBlocklist?: unknown }
const before = () => Math.floor(Date.now() / 1000) - 5

beforeEach(() => {
  delete shared.__blendnBlocklist
  mockFindMany.mockReset().mockResolvedValue([])
})

it("a phone sign-out or a block told to one copy is refused by another, and only for tokens from before it", async () => {
  const action = aCopy()
  const route = aCopy()
  const issued = before()
  expect(await route.recentlyBlocked("u1", issued)).toBe(false)

  action.phonesSignedOutNow("u1", new Date())
  expect(await route.recentlyBlocked("u1", issued)).toBe(true)
  expect(await route.recentlyBlocked("u1", issued + 60)).toBe(false)

  action.blockAccountNow("u2")
  expect(await route.recentlyBlocked("u2", issued + 60)).toBe(true)
})

it("a refresh that read the database before the action committed does not drop what the action said", async () => {
  const copy = aCopy()
  let answer!: (rows: unknown[]) => void
  mockFindMany.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
  const issued = before()

  const asked = copy.recentlyBlocked("u3", issued)
  copy.phonesSignedOutNow("u3", new Date())
  answer([])

  expect(await asked).toBe(true)
  expect(await copy.recentlyBlocked("u3", issued)).toBe(true)
})
