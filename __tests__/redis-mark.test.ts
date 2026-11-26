/**
 * The staff alert's "last run" mark in Redis (SCRUM-1161): best-effort and
 * bounded. A GET on a connection that dropped after `isReady` waits in the
 * offline queue, and the sweeper awaiting it would stop for good, silently.
 */
const never = () => new Promise<never>(() => {})

const mockValues = new Map<string, string>()
const mockClient = {
  isReady: true,
  values: mockValues,
  get: jest.fn((k: string) => Promise.resolve(mockValues.get(k) ?? null)),
  set: jest.fn((k: string, v: string) => (mockValues.set(k, v), Promise.resolve("OK"))),
  on(event: string, fn: () => void) {
    if (event === "ready") fn()
  },
  connect: jest.fn(() => Promise.resolve()),
}
jest.mock("redis", () => ({ createClient: () => mockClient }))

const load = () => import("@/lib/rate-limit-store")

beforeAll(() => {
  process.env.REDIS_URL = "redis://local:6379"
})
afterAll(() => {
  delete process.env.REDIS_URL
})
beforeEach(() => {
  jest.resetModules()
  jest.clearAllMocks()
  jest.useRealTimers()
  mockClient.isReady = true
  mockClient.values.clear()
  mockClient.get.mockImplementation((k: string) => Promise.resolve(mockValues.get(k) ?? null))
  mockClient.set.mockImplementation((k: string, v: string) => (mockValues.set(k, v), Promise.resolve("OK")))
})

it("round-trips a value", async () => {
  const { readMark, writeMark } = await load()
  await writeMark("k", "2026-11-26T00:00:00.000Z")
  expect(await readMark("k")).toBe("2026-11-26T00:00:00.000Z")
  expect(await readMark("missing")).toBeNull()
})

it("answers null within the bound when a GET never returns", async () => {
  const { readMark } = await load()
  mockClient.get.mockImplementation(never)
  const started = Date.now()
  expect(await readMark("k")).toBeNull()
  expect(Date.now() - started).toBeLessThan(1_900)
})

it("never throws: a failing read is null, a failing or hung write returns", async () => {
  const { readMark, writeMark } = await load()
  mockClient.get.mockRejectedValue(new Error("down"))
  mockClient.set.mockImplementation(never)
  await expect(readMark("k")).resolves.toBeNull()
  await expect(writeMark("k", "v")).resolves.toBeUndefined()
})

it("does nothing without Redis", async () => {
  delete process.env.REDIS_URL
  const { readMark, writeMark } = await load()
  await writeMark("k", "v")
  expect(await readMark("k")).toBeNull()
  expect(mockClient.set).not.toHaveBeenCalled()
  process.env.REDIS_URL = "redis://local:6379"
})

// A module, not a script: its top-level names must not collide with other test files under tsc.
export {}
