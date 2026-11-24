/**
 * A gallery upload writes to the item it was started on, with that file's own
 * poster (task 30 item 7, found in SCRUM-1066). Two bugs:
 * - a clip uploaded into an item that already had a poster kept the OLD clip's poster;
 * - an upload that finished after its item was reordered or removed wrote to
 *   whatever item then sat at the old index.
 */
import { uploadMediaItem, type UploadMediaDeps } from "@/components/event-form/upload-media-item"

type Item = { id: string; type: "image" | "video" | "document"; url: string; thumbnail_url?: string; width?: number; height?: number; duration_ms?: number; focal_x?: number; focal_y?: number }

type Harness = { items: Item[]; uploads: string[] }

function harness(initial: Item[], opts: { posterFails?: boolean; duringUpload?: (h: Harness) => void; size?: { width: number; height: number; duration_ms?: number } | null } = {}) {
  const h: Harness = { items: initial, uploads: [] }
  const deps: UploadMediaDeps = {
    items: () => h.items,
    write: (index, patch) => {
      h.items = h.items.map((m, i) => (i === index ? { ...m, ...patch } : m))
    },
    upload: async (file) => {
      if (h.uploads.length === 0) opts.duringUpload?.(h)
      h.uploads.push(file.name)
      return `https://cdn.test/${file.name}`
    },
    readSize: async () => (opts.size === undefined ? { width: 1080, height: 1350 } : opts.size),
    capturePoster: async () => {
      if (opts.posterFails) throw new Error("cannot decode")
      return new Blob(["jpeg"], { type: "image/jpeg" })
    },
    onProgress: () => {},
  }
  return { h, deps }
}

const clip = new File(["mp4"], "new.mp4", { type: "video/mp4" })
const still = new File(["jpg"], "new.jpg", { type: "image/jpeg" })

describe("uploadMediaItem", () => {
  it("forgets the old file's focal point: the subject of another picture is somewhere else (SCRUM-1106)", async () => {
    const { h, deps } = harness([{ id: "a", type: "video", url: "https://cdn.test/old.mp4", focal_x: 0.9, focal_y: 0.1 }])
    await uploadMediaItem(clip, "a", deps)
    expect(h.items[0].focal_x).toBeUndefined()
    expect(h.items[0].focal_y).toBeUndefined()
    expect("focal_x" in h.items[0]).toBe(true)
  })

  it("replaces the old clip's poster with the new clip's first frame", async () => {
    const { h, deps } = harness([{ id: "a", type: "video", url: "https://cdn.test/old.mp4", thumbnail_url: "https://cdn.test/old-poster.jpg" }], { size: { width: 1080, height: 1920, duration_ms: 9000 } })
    const result = await uploadMediaItem(clip, "a", deps)
    expect(result).toEqual({ kind: "done", posterMissing: false })
    expect(h.items[0]).toMatchObject({ url: "https://cdn.test/new.mp4", thumbnail_url: "https://cdn.test/new-poster.jpg", width: 1080, height: 1920, duration_ms: 9000 })
  })

  it("clears the old poster when the new clip's frame cannot be read, and says so", async () => {
    const { h, deps } = harness([{ id: "a", type: "video", url: "https://cdn.test/old.mp4", thumbnail_url: "https://cdn.test/old-poster.jpg" }], { posterFails: true })
    const result = await uploadMediaItem(clip, "a", deps)
    expect(result).toEqual({ kind: "done", posterMissing: true })
    expect(h.items[0].thumbnail_url).toBe("")
  })

  it("replaces an image's old thumbnail with the new image", async () => {
    const { h, deps } = harness([{ id: "a", type: "image", url: "https://cdn.test/old.jpg", thumbnail_url: "https://cdn.test/old.jpg" }])
    await uploadMediaItem(still, "a", deps)
    expect(h.items[0]).toMatchObject({ url: "https://cdn.test/new.jpg", thumbnail_url: "https://cdn.test/new.jpg", width: 1080, height: 1350 })
  })

  it("writes to its own item after a reorder, not to the old index", async () => {
    const a: Item = { id: "a", type: "image", url: "https://cdn.test/a.jpg", thumbnail_url: "https://cdn.test/a.jpg" }
    const b: Item = { id: "b", type: "image", url: "" }
    const { h, deps } = harness([a, b], { duringUpload: (x) => { x.items = [x.items[1], x.items[0]] } })
    await uploadMediaItem(still, "b", deps)
    expect(h.items.map((m) => m.id)).toEqual(["b", "a"])
    expect(h.items[0].url).toBe("https://cdn.test/new.jpg")
    expect(h.items[1]).toEqual(a)
  })

  it("writes nothing when its item was removed during the upload", async () => {
    const a: Item = { id: "a", type: "image", url: "https://cdn.test/a.jpg" }
    const b: Item = { id: "b", type: "image", url: "" }
    const { h, deps } = harness([a, b], { duringUpload: (x) => { x.items = [x.items[0]] } })
    const result = await uploadMediaItem(still, "b", deps)
    expect(result).toEqual({ kind: "removed" })
    expect(h.items).toEqual([a])
  })

  it("refuses a clip over the limit before anything uploads", async () => {
    const { h, deps } = harness([{ id: "a", type: "video", url: "" }], { size: { width: 1080, height: 1920, duration_ms: 20_200 } })
    const result = await uploadMediaItem(clip, "a", deps)
    expect(result).toEqual({ kind: "refused", reason: expect.stringContaining("20.2 seconds") })
    expect(h.uploads).toEqual([])
    expect(h.items[0].url).toBe("")
  })
})
