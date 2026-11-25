jest.mock("@/lib/tigris", () => ({
  isConfigured: () => true,
  presignedPut: async (key: string) => ({ uploadUrl: `https://put.test/${key}?sig`, publicUrl: `https://cdn.test/${key}` }),
}))

import { checkClip, clipCheckOn, refusalWords } from "@/lib/media-clip"

const env = { ...process.env }
const fetchMock = jest.fn()
const pause = async () => {}
const ok = {
  ok: true, width: 1280, height: 720, durationMs: 12_000, stillSeconds: [0.1, 2, 4],
  main: { width: 1280, height: 720, bytes: 3_000_000 }, small: { width: 960, height: 540, bytes: 1_500_000 },
}
const answer = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status })

beforeEach(() => {
  process.env = { ...env, MEDIA_WORKER_URL: "http://media-worker.railway.internal:8080/", MEDIA_WORKER_SECRET: "x".repeat(32) }
  fetchMock.mockReset()
  global.fetch = fetchMock as never
})
afterAll(() => {
  process.env = env
})

describe("checkClip (SCRUM-1106)", () => {
  it.each(["MEDIA_WORKER_URL", "MEDIA_WORKER_SECRET"])("is off without %s, and asks nobody", async (name) => {
    delete process.env[name]
    expect(clipCheckOn()).toBe(false)
    expect(await checkClip("https://a.test/c.mp4", "u1", pause)).toEqual({ kind: "unavailable" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("hands the worker the link and its upload URLs, and nothing that opens storage", async () => {
    fetchMock.mockResolvedValue(answer(200, ok))
    const result = await checkClip("https://a.test/c.mp4", "u1", pause)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("http://media-worker.railway.internal:8080/clip")
    expect(init.headers.authorization).toBe(`Bearer ${"x".repeat(32)}`)
    const sent = JSON.parse(init.body)
    expect(Object.keys(sent)).toEqual(["url", "uploads"])
    expect([sent.uploads.main, sent.uploads.small, ...sent.uploads.stills].every((u: string) => u.startsWith("https://put.test/events/u1/clips/"))).toBe(true)
    expect(sent.uploads.stills).toHaveLength(6)
    expect(result).toMatchObject({
      kind: "ok",
      clip: { width: 1280, height: 720, duration_ms: 12_000, renditions: [{ width: 960, height: 540, bytes: 1_500_000 }, { width: 1280, height: 720 }] },
    })
    if (result.kind !== "ok") throw new Error("not ok")
    expect(result.clip.stills.map((s) => s.at)).toEqual([0.1, 2, 4])
    expect(result.clip.stills[0].url).toMatch(/^https:\/\/cdn\.test\/events\/u1\/clips\/[0-9a-f-]{36}\/still-0\.jpg$/)
    expect(result.clip.renditions[0].url).toMatch(/small\.mp4$/)
  })

  it("waits out a wake: a 502 and a refused connection are asked again", async () => {
    fetchMock.mockResolvedValueOnce(answer(502)).mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(answer(200, ok))
    expect((await checkClip("https://a.test/c.mp4", "u1", pause)).kind).toBe("ok")
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it.each([["busy", () => Promise.resolve(answer(503))], ["failed", () => Promise.resolve(answer(500))], ["wrong secret", () => Promise.resolve(answer(401))], ["timed out", () => Promise.reject(new DOMException("t", "TimeoutError"))], ["nonsense", () => Promise.resolve(answer(200, { ok: true }))]])(
    "is unavailable, not a verdict, and not asked again: %s",
    async (_why, reply) => {
      fetchMock.mockImplementation(reply)
      expect(await checkClip("https://a.test/c.mp4", "u1", pause)).toEqual({ kind: "unavailable" })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  )

  it("checks one clip per person at a time, and frees the place even after a failure", async () => {
    let release = (_: Response) => {}
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => (release = resolve)))
    const first = checkClip("https://a.test/c.mp4", "u1", pause)
    expect(await checkClip("https://a.test/d.mp4", "u1", pause)).toEqual({ kind: "unavailable" })
    fetchMock.mockResolvedValueOnce(answer(200, ok))
    expect((await checkClip("https://a.test/e.mp4", "u2", pause)).kind).toBe("ok")
    await new Promise((resolve) => setImmediate(resolve))
    release(answer(500))
    expect((await first).kind).toBe("unavailable")
    fetchMock.mockResolvedValueOnce(answer(200, ok))
    expect((await checkClip("https://a.test/c.mp4", "u1", pause)).kind).toBe("ok")
  })

  it("gives up after a few refused connections", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"))
    expect(await checkClip("https://a.test/c.mp4", "u1", pause)).toEqual({ kind: "unavailable" })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it("does not run a job again that dropped after it had started", async () => {
    const now = jest.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(60_000)
    fetchMock.mockRejectedValue(new TypeError("terminated"))
    expect(await checkClip("https://a.test/c.mp4", "u1", pause)).toEqual({ kind: "unavailable" })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    now.mockRestore()
  })

  it("refuses in the advisor's words", async () => {
    fetchMock.mockResolvedValue(answer(200, { ok: false, reason: "too_long", durationMs: 20_200 }))
    expect(await checkClip("https://a.test/c.mp4", "u1", pause)).toEqual({
      kind: "refused",
      message: "This clip is 20.2 seconds. Clips play up to 15 seconds: trim it and add it again.",
    })
    expect(refusalWords({ ok: false, reason: "too_big", bytes: 64 * 1024 * 1024 })).toBe("This clip is 64 MB. Clips can be up to 50 MB: export it smaller and add it again.")
    expect(refusalWords({ ok: false, reason: "too_big" })).toMatch(/^This clip is over 50 MB\./)
    expect(refusalWords({ ok: false, reason: "not_video" })).toBe("This link isn’t a video file. Paste a direct link to an MP4.")
    expect(refusalWords({ ok: false, reason: "unreachable" })).toBe("We couldn’t open this link. Check that it’s public, then paste it again.")
  })

  it("refuses a Dolby Vision clip it cannot convert in the advisor's words (SCRUM-1120)", async () => {
    fetchMock.mockResolvedValue(answer(200, { ok: false, reason: "unsupported_hdr" }))
    expect(await checkClip("https://a.test/c.mp4", "u1", pause)).toEqual({
      kind: "refused",
      message: "This clip is in a Dolby Vision format we can’t convert, so its colors would play wrong: export it as HDR10 or standard (SDR) video and add it again.",
    })
  })
})
