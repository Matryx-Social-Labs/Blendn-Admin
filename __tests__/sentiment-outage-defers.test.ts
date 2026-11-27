/**
 * SCRUM-1481: a model outage defers an un-cued line instead of settling it for good.
 *
 * When a batch call failed, `classifyMessages` gave every message in it the word list's guess (`neutral / other`,
 * `source: "lexicon"`), and the sweeper never read a message with a row again. Since SCRUM-1231 every non-English line
 * needs the model, so during an outage a Hindi or Kannada help request was settled neutral for good and never reached
 * staff. Now an un-cued line whose call failed gets no row and is read again on the next pass; only when it is about to
 * leave the sweeper's 6 h window does it get the word list's guess, every such line at once, with one error that counts
 * them. A cued line keeps its fallback: an outage must not hold back a possible report.
 *
 * The database is a fake that answers the sweeper's three statements (the pass's read, the band's read, the write);
 * the SQL itself is driven against Postgres in `integration/sentiment-sweeper.itest.ts`.
 */
const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }
jest.mock("@/lib/logger", () => ({ logger }))
const beat = jest.fn()
jest.mock("@/lib/heartbeat", () => ({ beat: (...a: unknown[]) => beat(...a) }))

interface Waiting {
  id: string
  content: string
  user_id: string
  chat_group_id: string
  event_id: string
  /** In the last minutes of the scan window: the SQL's `last_pass`. */
  band?: boolean
}
interface Row {
  sentiment: string
  category: string
  source: string
}

let waiting: Waiting[] = []
const rows = new Map<string, Row>()
const flagged: string[] = []
const reads: string[] = []

const queryRaw = jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const sql = strings.join("?")
  if (sql.includes("INSERT INTO event_feedback")) {
    const [, ids, sentiments, categories, , , sources] = values as string[][]
    ids.forEach((id, i) => rows.set(id, { sentiment: sentiments[i], category: categories[i], source: sources[i] }))
    return ids.map((message_id) => ({ message_id }))
  }
  const open = waiting.filter((m) => !rows.has(m.id))
  if (sql.includes("OVER ()")) {
    reads.push("band")
    const band = open.filter((m) => m.band)
    const cap = values.find((v) => typeof v === "number") as number
    return band.slice(0, cap).map((m) => ({ ...m, waiting: BigInt(band.length) }))
  }
  reads.push("pass")
  return [...open.filter((m) => m.band), ...open.filter((m) => !m.band)].slice(0, 201).map((m) => ({ ...m, last_pass: Boolean(m.band) }))
})

jest.mock("@/lib/db", () => ({
  db: {
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => queryRaw(strings, ...values),
    moderation_flags: {
      findFirst: async () => null,
      create: async ({ data }: { data: { message_id: string } }) => {
        flagged.push(data.message_id)
        return {}
      },
    },
    chat_messages: { updateMany: async () => ({ count: 1 }) },
    $transaction: async (ops: Array<Promise<unknown>>) => Promise.all(ops),
  },
}))

import { SWEEP_INTERVAL_MS, startSentimentSweeper, stopSentimentSweeper, sweepSentiment } from "@/lib/sentiment-sweeper"

const HINDI_HELP = "मुझे मदद चाहिए, बाहर एक आदमी मेरा पीछा कर रहा है"
const KANNADA_HELP = "ನನಗೆ ಸಹಾಯ ಬೇಕು, ಯಾರೋ ನನ್ನನ್ನು ಹಿಂಬಾಲಿಸುತ್ತಿದ್ದಾರೆ"
const UNCUED = "where is the bar"
const CUED = "some guy keeps grabbing my friend"
const SETTLED = "is the dj on yet or later"

const line = (id: string, content: string, room = "room-a", band = false): Waiting => ({
  id,
  content,
  user_id: "user-1",
  chat_group_id: room,
  event_id: `event-of-${room}`,
  band,
})

const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>()
const sentIds = (call: number): string[] =>
  JSON.parse(JSON.parse(String(fetchMock.mock.calls[call][1].body)).messages[1].content).map((m: { id: string }) => m.id)

/** The model labels every line it is sent, neutral / other. */
function modelAnswers() {
  fetchMock.mockImplementation(async (_url, init) => {
    const sent = JSON.parse(JSON.parse(String(init.body)).messages[1].content) as Array<{ id: string }>
    const results = sent.map((m) => ({ id: m.id, sentiment: "neutral", category: "other", topic: null, confidence: 0.9 }))
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results }) } }] }), { status: 200 })
  })
}
const modelDown = () => fetchMock.mockImplementation(async () => new Response("", { status: 503 }))
const modelTimesOut = () =>
  fetchMock.mockImplementation(async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError")
  })

/** One pass, letting the retry's backoff run. */
async function pass() {
  const pending = sweepSentiment()
  await jest.runAllTimersAsync()
  return pending
}

const windowErrors = () => logger.error.mock.calls.filter(([message]) => /left the window/.test(String(message)))

const saved = process.env.OPENAI_API_KEY

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test-key"
  waiting = []
  rows.clear()
  flagged.length = 0
  reads.length = 0
  queryRaw.mockClear()
  fetchMock.mockReset()
  beat.mockReset()
  for (const fn of Object.values(logger)) fn.mockReset()
  jest.spyOn(global, "fetch").mockImplementation(fetchMock as unknown as typeof fetch)
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] })
})

afterEach(() => {
  stopSentimentSweeper()
  jest.useRealTimers()
  jest.restoreAllMocks()
  if (saved === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = saved
})

describe("a failed call leaves an un-cued line unclassified, and the next pass reads it again", () => {
  it.each([
    ["answered 503 twice", modelDown],
    ["timed out twice", modelTimesOut],
  ])("a batch that %s writes no row for its lines; the next pass sends the same ids and writes llm rows", async (_how, fail) => {
    waiting = [line("hindi", HINDI_HELP), line("kannada", KANNADA_HELP), line("bar", UNCUED), line("dj", SETTLED)]
    fail()

    await pass()

    // The word list still settles what it is sure of; nothing the model was asked about has a row.
    expect(rows.get("dj")).toMatchObject({ source: "lexicon" })
    expect(rows.has("hindi")).toBe(false)
    expect(rows.has("kannada")).toBe(false)
    expect(rows.has("bar")).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const firstIds = sentIds(0)

    fetchMock.mockReset()
    modelAnswers()
    await pass()

    expect(sentIds(0).sort()).toEqual(firstIds.sort())
    expect(fetchMock).toHaveBeenCalledTimes(1)
    for (const id of ["hindi", "kannada", "bar"]) expect(rows.get(id)).toMatchObject({ source: "llm" })
  })

  it("does not count a deferred line as written, and does not come straight back for it", async () => {
    // More than a pass's worth waiting: a healthy backlog re-passes at 1 s, an outage must not.
    waiting = Array.from({ length: 250 }, (_, i) => line(`m${i}`, `${UNCUED} ${i}`))
    modelDown()

    const result = await pass()

    expect(result).toEqual({ classified: 0, hasMore: false })
  })

  it("a missing key is configuration, not an outage: the word list settles at once, as before", async () => {
    delete process.env.OPENAI_API_KEY
    waiting = [line("hindi", HINDI_HELP), line("bar", UNCUED)]

    await pass()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(rows.get("hindi")).toMatchObject({ source: "lexicon", sentiment: "neutral" })
    expect(rows.get("bar")).toMatchObject({ source: "lexicon" })
    expect(windowErrors()).toHaveLength(0)
  })
})

describe("an outage costs a round of calls a pass, not a pass's worth", () => {
  it("stops calling after a round of four calls that all failed", async () => {
    // Ten rooms, one line each: ten calls. Negative control: every one was sent, twice.
    waiting = Array.from({ length: 10 }, (_, i) => line(`m${i}`, UNCUED, `room-${i}`))
    modelDown()

    await pass()

    expect(fetchMock).toHaveBeenCalledTimes(4 * 2)
    expect(rows.size).toBe(0)
  })

  it("keeps calling when a round had one answer: a bad batch is not an outage", async () => {
    waiting = Array.from({ length: 10 }, (_, i) => line(`m${i}`, UNCUED, `room-${i}`))
    let call = 0
    fetchMock.mockImplementation(async (_url, init) => {
      call += 1
      // Every other call answers, so every round has one answer.
      if (call % 2 === 0) return new Response("", { status: 400 })
      const [sent] = JSON.parse(JSON.parse(String(init.body)).messages[1].content) as Array<{ id: string }>
      const results = [{ id: sent.id, sentiment: "neutral", category: "other", topic: null, confidence: 0.9 }]
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results }) } }] }), { status: 200 })
    })

    await pass()

    expect(fetchMock).toHaveBeenCalledTimes(10)
    expect(rows.size).toBe(5)
  })
})

describe("a cued line still flags from its cue when the model is down", () => {
  it("flags every selected cued line, the one whose own call the stopped pass never made included", async () => {
    // Four cued calls fail and stop the pass; the fifth cued line is never sent, and must flag all the same.
    waiting = [...Array.from({ length: 5 }, (_, i) => line(`cue${i}`, `${CUED} ${i}`)), line("hindi", HINDI_HELP)]
    modelDown()

    await pass()

    expect(fetchMock).toHaveBeenCalledTimes(4 * 2)
    for (let i = 0; i < 5; i++) expect(rows.get(`cue${i}`)).toMatchObject({ category: "safety_conduct", source: "lexicon" })
    expect(flagged.sort()).toEqual(["cue0", "cue1", "cue2", "cue3", "cue4"])
    expect(rows.has("hindi")).toBe(false)
  })
})

describe("a line about to leave the window gets the word list's guess, every one of them, and one error", () => {
  it("writes a row for each band line of a failed pass, more than a pass's worth, and logs one error with the count", async () => {
    // 250 lines in the last minutes of the window, in two rooms; a pass reads 200. Negative control: 200 rows, 50
    // left the window unrowed, nothing counted.
    waiting = [
      ...Array.from({ length: 150 }, (_, i) => line(`a${i}`, `${UNCUED} ${i}`, "room-a", true)),
      ...Array.from({ length: 100 }, (_, i) => line(`b${i}`, `${HINDI_HELP} ${i}`, "room-b", true)),
      line("fresh", KANNADA_HELP, "room-a"),
    ]
    modelDown()

    const result = await pass()

    expect(waiting.filter((m) => m.band).every((m) => rows.get(m.id)?.source === "lexicon")).toBe(true)
    expect(rows.has("fresh")).toBe(false)
    expect(result.classified).toBe(250)
    expect(windowErrors()).toHaveLength(1)
    const [, meta] = windowErrors()[0]
    expect(meta).toEqual({ settled: 250, unsettled: 0 })
  })

  it("flags a cued line in the band that the pass never read, from its cue", async () => {
    // 200 band lines fill the pass; the cued one after them is reached only by the band's settle.
    waiting = [...Array.from({ length: 200 }, (_, i) => line(`m${i}`, `${UNCUED} ${i}`, "room-a", true)), line("cue", CUED, "room-a", true)]
    modelDown()

    await pass()

    expect(rows.get("cue")).toMatchObject({ category: "safety_conduct", source: "lexicon" })
    expect(flagged).toEqual(["cue"])
  })

  it("counts in the same error the lines past the pass's cap, which leave the window unrowed", async () => {
    waiting = Array.from({ length: 5_003 }, (_, i) => line(`m${i}`, `${UNCUED} ${i}`, "room-a", true))
    modelDown()

    await pass()

    expect(rows.size).toBe(5_000)
    expect(windowErrors()).toHaveLength(1)
    expect(windowErrors()[0][1]).toEqual({ settled: 5_000, unsettled: 3 })
  })

  it("reads no band and logs no error on a pass the model answered", async () => {
    waiting = [line("old", UNCUED, "room-a", true), line("new", HINDI_HELP)]
    modelAnswers()

    await pass()

    expect(reads).toEqual(["pass"])
    expect(rows.get("old")).toMatchObject({ source: "llm" })
    expect(windowErrors()).toHaveLength(0)
  })

  it("says nothing in the error but the counts: no text, no id", async () => {
    waiting = [line("hindi-band", HINDI_HELP, "room-a", true)]
    modelDown()

    await pass()

    const text = JSON.stringify(windowErrors())
    expect(text).not.toContain("hindi-band")
    expect(text).not.toContain("मदद")
  })
})

describe("the loop through an outage", () => {
  /** Lets the first pass start, then runs its retry backoffs. */
  async function firstPass() {
    startSentimentSweeper()
    beat.mockClear()
    await jest.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS)
    for (let i = 0; i < 6; i++) await jest.advanceTimersByTimeAsync(2_000)
  }

  it("beats after a pass the outage cut short, and waits the interval before the next", async () => {
    waiting = Array.from({ length: 250 }, (_, i) => line(`m${i}`, `${UNCUED} ${i}`, `room-${i % 10}`))
    modelDown()

    await firstPass()

    expect(beat).toHaveBeenCalledWith("sentiment", expect.any(Number))
    expect(reads.filter((r) => r === "pass")).toHaveLength(1)
    await jest.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS - 20_000)
    expect(reads.filter((r) => r === "pass")).toHaveLength(1)
  })

  it("comes straight back for a backlog once the model answers again", async () => {
    waiting = Array.from({ length: 250 }, (_, i) => line(`m${i}`, `${UNCUED} ${i}`, `room-${i % 10}`))
    modelAnswers()

    await firstPass()

    expect(reads.filter((r) => r === "pass").length).toBeGreaterThanOrEqual(2)
    expect(rows.size).toBe(250)
  })
})
