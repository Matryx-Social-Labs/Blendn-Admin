import { cover, mirrorToTigris, revivedCover, SEED_BUCKET, seedBucketUrl, stayedHotlinked } from "../scripts/seed-media"

/*
 * SCRUM-285. Every seeded cover on staging went blank on 2026-09-24:
 * loremflickr began answering non-browser clients with a 401 "Bot check" page,
 * and the phone's image loader is a non-browser client. The six events meant
 * to be immune — mirrored into our own bucket — were not, because the last
 * re-seed ran without Tigris credentials and wrote the hotlink over the bucket
 * URL that was still there and still serving.
 */
describe("seed covers", () => {
  const originalFetch = global.fetch
  afterEach(() => {
    global.fetch = originalFetch
  })

  const respond = (status: number) =>
    jest.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status } as Response)

  it("hotlinks a host that serves a phone, not a bot-checked one", () => {
    // picsum answers okhttp and CFNetwork with an image (probed for every
    // subject, 2026-09-24); loremflickr and Unsplash's search now answer both
    // with an HTML challenge.
    expect(cover("rooftop")).toBe("https://picsum.photos/seed/blendn-rooftop/1600/1600")
    expect(cover("rooftop")).toBe(cover("rooftop"))
    expect(cover("club")).not.toBe(cover("rooftop"))
  })

  it("revives a copy of a seeded cover left on the retired host, and leaves every other URL alone", () => {
    // A dashboard duplicate or a hand-made test event copies the seeded URL,
    // so the dead host outlives the seed rows themselves (12 such events on
    // staging, 2026-09-24).
    expect(revivedCover("https://loremflickr.com/1600/1600/rooftop,party,sunset?lock=7521")).toBe(cover("rooftop"))
    expect(revivedCover("https://loremflickr.com/1600/1600/concert")).toBe(cover("concert"))
    expect(revivedCover("http://LoremFlickr.com/1600/1600/Concert")).toBe(cover("concert"))
    expect(revivedCover("https://blendn-media-staging.fly.storage.tigris.dev/seed/x/cover.jpg")).toBeNull()
    expect(revivedCover("https://example.com/loremflickr.com/1/1/a")).toBeNull()
    expect(revivedCover(null)).toBeNull()
  })

  it("keeps a cover that is already in our bucket, even with no Tigris credentials", async () => {
    global.fetch = respond(200)
    const url = await mirrorToTigris("https://picsum.photos/x", "seed/founders-filter-coffee/cover.jpg", "image/jpeg", {})

    expect(url).toBe(`https://${SEED_BUCKET}.fly.storage.tigris.dev/seed/founders-filter-coffee/cover.jpg`)
    // Bounded: a host that never answers must not stall the whole refresh.
    expect(global.fetch).toHaveBeenCalledWith(url, expect.objectContaining({ method: "HEAD", signal: expect.any(AbortSignal) }))
  })

  it("hotlinks when the bucket does not have it and there are no credentials to put it there", async () => {
    global.fetch = respond(404)
    await expect(mirrorToTigris("https://picsum.photos/x", "seed/new/cover.jpg", "image/jpeg", {})).resolves.toBe(
      "https://picsum.photos/x"
    )
  })

  it("hotlinks rather than failing the seed when the bucket cannot be reached", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("ENOTFOUND"))
    await expect(mirrorToTigris("https://picsum.photos/x", "seed/new/cover.jpg", "image/jpeg", {})).resolves.toBe(
      "https://picsum.photos/x"
    )
  })
})

describe("naming what stayed hotlinked (SCRUM-288)", () => {
  // The documented --apply passed no Tigris variables, so every object meant
  // for our bucket that was not already there stayed hotlinked — one log line
  // among hundreds. The run now ends by naming them.
  it("names the objects meant for our bucket that came back on someone else's host", () => {
    const key = "seed/founders-filter-coffee/cover.jpg"
    expect(
      stayedHotlinked([
        { key, url: "https://images.example.com/founders.jpg" },
        { key: "seed/nightshift/cover.jpg", url: seedBucketUrl("seed/nightshift/cover.jpg") },
        { key: "seed/nightshift/clip.mp4", url: null },
      ])
    ).toEqual([key])
  })

  it("puts a key at the bucket's public URL", () => {
    expect(seedBucketUrl("seed/x/cover.jpg")).toBe(`https://${SEED_BUCKET}.fly.storage.tigris.dev/seed/x/cover.jpg`)
  })
})
