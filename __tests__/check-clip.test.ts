import { checkMediaClip, clipFacts, stillClock, type CheckClipDeps, type ClipAnswer } from "@/components/event-form/check-clip"
import { eventFormSchema } from "@/components/event-form/schema"

type Item = { id: string; type: "image" | "video" | "document"; url: string; thumbnail_url?: string; renditions?: unknown; clip_refusal?: string; width?: number }

const clip = {
  width: 1280, height: 720, duration_ms: 12_000,
  stills: [{ url: "https://cdn.test/still-0.jpg", at: 0.1 }, { url: "https://cdn.test/still-1.jpg", at: 2 }],
  renditions: [{ url: "https://cdn.test/small.mp4", width: 960, height: 540, bytes: 1 }],
}

function harness(initial: Item[], answer: ClipAnswer, during?: (h: { items: Item[] }) => void) {
  const h = { items: initial, asked: [] as string[] }
  const deps: CheckClipDeps = {
    items: () => h.items,
    write: (index, patch) => {
      h.items = h.items.map((m, i) => (i === index ? ({ ...m, ...patch } as Item) : m))
    },
    ask: async (url) => {
      h.asked.push(url)
      during?.(h)
      return answer
    },
  }
  return { h, deps }
}
const video = (over: Partial<Item> = {}): Item => ({ id: "a", type: "video", url: "https://x.test/a.mp4", ...over })

describe("checkMediaClip (SCRUM-1106)", () => {
  it("fills in the size, the copies and the opening frame of a new clip", async () => {
    const { h, deps } = harness([video({ thumbnail_url: "https://old.test/p.jpg", clip_refusal: "old" })], { kind: "ok", clip })
    expect(await checkMediaClip("a", deps, true)).toEqual({ kind: "done", stills: clip.stills })
    expect(h.items[0]).toMatchObject({ width: 1280, height: 720, duration_ms: 12_000, renditions: clip.renditions, thumbnail_url: clip.stills[0].url })
    expect(h.items[0].clip_refusal).toBeUndefined()
  })

  it("keeps the still its organizer chose when a saved clip is checked again", async () => {
    const chosen = harness([video({ thumbnail_url: "https://cdn.test/mine.jpg" })], { kind: "ok", clip })
    await checkMediaClip("a", chosen.deps, false)
    expect(chosen.h.items[0].thumbnail_url).toBe("https://cdn.test/mine.jpg")
    const none = harness([video({ thumbnail_url: "" })], { kind: "ok", clip })
    await checkMediaClip("a", none.deps, false)
    expect(none.h.items[0].thumbnail_url).toBe(clip.stills[0].url)
  })

  it("writes to its own item after a reorder", async () => {
    const { h, deps } = harness([video(), video({ id: "b", url: "https://x.test/b.mp4" })], { kind: "ok", clip }, (s) => {
      s.items = [...s.items].reverse()
    })
    await checkMediaClip("a", deps, true)
    expect(h.items.map((m) => [m.id, m.width])).toEqual([["b", undefined], ["a", 1280]])
  })

  it.each([
    ["retyped", (s: { items: Item[] }) => void (s.items = [video({ url: "https://x.test/other.mp4" })])],
    ["removed", (s: { items: Item[] }) => void (s.items = [])],
    ["made an image", (s: { items: Item[] }) => void (s.items = [video({ type: "image" })])],
  ])("gives a clip that was %s meanwhile nothing", async (_why, during) => {
    const { h, deps } = harness([video()], { kind: "ok", clip }, during)
    expect(await checkMediaClip("a", deps, true)).toBeNull()
    expect(h.items.every((m) => m.width === undefined)).toBe(true)
  })

  it("marks a refused clip and drops its copies; a failed check writes nothing", async () => {
    const refused = harness([video({ renditions: clip.renditions })], { kind: "refused", message: "Too long." })
    await checkMediaClip("a", refused.deps, true)
    expect(refused.h.items[0]).toMatchObject({ clip_refusal: "Too long.", renditions: undefined })
    const failed = harness([video()], { kind: "failed", message: "Later." })
    expect(await checkMediaClip("a", failed.deps, true)).toEqual({ kind: "failed", message: "Later.", newClip: true })
    expect(failed.h.items[0]).toEqual(video())
  })

  it("asks nothing about an image or an empty link", async () => {
    const { h, deps } = harness([video({ type: "image" }), video({ id: "b", url: "" })], { kind: "ok", clip })
    expect(await checkMediaClip("a", deps, true)).toBeNull()
    expect(await checkMediaClip("b", deps, true)).toBeNull()
    expect(h.asked).toEqual([])
  })
})

describe("a refused clip stops the save", () => {
  const item = { id: "a", type: "video", url: "https://x.test/a.mp4", clip_refusal: "Too long." }
  const issues = (media: object) =>
    (eventFormSchema.shape.media_items.safeParse([media]).error?.issues ?? []).map((i) => [i.path.join("."), i.message])
  it("under its URL, and only while it is a video", () => {
    expect(issues(item)).toEqual([["0.url", "Too long."]])
    expect(issues({ ...item, type: "image" })).toEqual([])
    expect(issues({ ...item, clip_refusal: undefined })).toEqual([])
  })
})

it("says a clip's facts and a still's time", () => {
  expect(clipFacts(1280, 720, 12_000)).toBe("12.0 s · 1280 × 720")
  expect([0.1, 7.9, 61].map(stillClock)).toEqual(["0:00", "0:07", "1:01"])
})
