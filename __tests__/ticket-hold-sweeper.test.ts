import { readFileSync } from "fs"
import { join } from "path"

jest.mock("@/lib/ticket-holds", () => ({ releaseExpiredHolds: jest.fn() }))
jest.mock("@/lib/logger", () => ({ logger: { info: jest.fn(), error: jest.fn() } }))

import { releaseExpiredHolds } from "@/lib/ticket-holds"
import { TICKET_HOLD_SWEEP_MS, startTicketHoldSweeper, stopTicketHoldSweeper, sweepTicketHolds } from "@/lib/ticket-hold-sweeper"

/**
 * The ticket hold sweeper (SCRUM-1010): every minute while TICKETING is on,
 * nothing at all while it is off, started and stopped with the rest of the
 * background work.
 */

const release = releaseExpiredHolds as jest.Mock
const flush = () => new Promise((resolve) => jest.requireActual<typeof import("timers")>("timers").setImmediate(resolve))

let previousFlag: string | undefined
beforeEach(() => {
  previousFlag = process.env.TICKETING
  release.mockReset().mockResolvedValue({ released: 0 })
  jest.useFakeTimers()
})
afterEach(() => {
  stopTicketHoldSweeper()
  jest.useRealTimers()
  process.env.TICKETING = previousFlag
})

it("runs every 60 seconds while TICKETING is on", async () => {
  process.env.TICKETING = "true"
  expect(TICKET_HOLD_SWEEP_MS).toBe(60_000)

  startTicketHoldSweeper()
  await flush()
  expect(release).toHaveBeenCalledTimes(1)

  jest.advanceTimersByTime(TICKET_HOLD_SWEEP_MS - 1)
  await flush()
  expect(release).toHaveBeenCalledTimes(1)
  jest.advanceTimersByTime(1)
  await flush()
  expect(release).toHaveBeenCalledTimes(2)
})

it("starts nothing while TICKETING is off", async () => {
  process.env.TICKETING = "false"
  startTicketHoldSweeper()
  jest.advanceTimersByTime(10 * TICKET_HOLD_SWEEP_MS)
  await flush()
  expect(release).not.toHaveBeenCalled()
  expect(jest.getTimerCount()).toBe(0)
})

it("keeps taking batches while they come back with work, and stops at an empty one", async () => {
  release.mockResolvedValueOnce({ released: 200 }).mockResolvedValueOnce({ released: 7 }).mockResolvedValueOnce({ released: 0 })
  expect(await sweepTicketHolds()).toBe(207)
  expect(release).toHaveBeenCalledTimes(3)
})

it("is started and stopped with the background work", () => {
  const bg = readFileSync(join(__dirname, "..", "lib/background.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
  expect(bg).toMatch(/startTicketHoldSweeper\(\)/)
  expect(bg).toMatch(/stopTicketHoldSweeper\(\)/)
})
