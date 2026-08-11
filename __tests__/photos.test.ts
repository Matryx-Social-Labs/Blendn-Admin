import { ownedPhotoKey } from "@/lib/tigris"

/*
 * `photos` is `z.string().url()` and nothing more, and the client uploads
 * straight to Tigris then posts the URL back. The moment the server *fetches*
 * one — to moderate it, to size it — that field is an SSRF primitive.
 *
 * `ownedPhotoKey` is what stands between the two. Every test below is a URL
 * somebody would try, and every one of them is a `null` rather than a fetch.
 *
 * The bucket defaults to `blendn-media` when `TIGRIS_BUCKET` is unset, which is
 * the case in the test environment.
 */

const USER = "user-123"
const OK = `https://blendn-media.fly.storage.tigris.dev/profile/${USER}/1699-abc-photo.jpg`

describe("ownedPhotoKey accepts our own bucket", () => {
  it("returns the key for a well-formed URL the app produced", () => {
    expect(ownedPhotoKey(OK, USER)).toBe(`profile/${USER}/1699-abc-photo.jpg`)
  })

  it("accepts the alternate Tigris host", () => {
    const url = `https://blendn-media.t3.storage.dev/profile/${USER}/x.jpg`
    expect(ownedPhotoKey(url, USER)).toBe(`profile/${USER}/x.jpg`)
  })

  it("ignores a query string and fragment", () => {
    expect(ownedPhotoKey(`${OK}?v=2#top`, USER)).toBe(`profile/${USER}/1699-abc-photo.jpg`)
  })
})

describe("ownedPhotoKey refuses everything else", () => {
  const cases: [string, string][] = [
    ["an internal metadata endpoint", "https://169.254.169.254/latest/meta-data/"],
    ["localhost", "https://localhost/profile/user-123/x.jpg"],
    ["a private address", "https://10.0.0.1/profile/user-123/x.jpg"],
    ["an arbitrary host", "https://evil.example/profile/user-123/x.jpg"],
    [
      "a host that merely CONTAINS ours — the substring trap",
      "https://evil.example/?x=blendn-media.fly.storage.tigris.dev/profile/user-123/x.jpg",
    ],
    [
      "a host that merely ENDS with ours",
      "https://blendn-media.fly.storage.tigris.dev.evil.example/profile/user-123/x.jpg",
    ],
    [
      "a host that merely STARTS with ours",
      "https://notblendn-media.fly.storage.tigris.dev/profile/user-123/x.jpg",
    ],
    ["plain http to our own bucket", "http://blendn-media.fly.storage.tigris.dev/profile/user-123/x.jpg"],
    ["a file URL", "file:///etc/passwd"],
    ["not a URL at all", "profile/user-123/x.jpg"],
    ["empty", ""],
  ]

  it.each(cases)("refuses %s", (_label, url) => {
    expect(ownedPhotoKey(url, USER)).toBeNull()
  })

  it("refuses somebody else's photo in our own bucket", () => {
    /*
     * The one an authenticated user can actually reach. The key format is
     * `profile/<userId>/…`, so ownership is provable from the URL — no database
     * round trip, and no way to point moderation (or a future thumbnailer) at a
     * stranger's object.
     */
    const url = "https://blendn-media.fly.storage.tigris.dev/profile/someone-else/x.jpg"
    expect(ownedPhotoKey(url, USER)).toBeNull()
  })

  it("refuses a different folder — chat media is a different trust class", () => {
    const url = `https://blendn-media.fly.storage.tigris.dev/chat/${USER}/x.jpg`
    expect(ownedPhotoKey(url, USER)).toBeNull()
  })

  it("refuses a prefix match on the user id", () => {
    // `profile/user-1234/` must not satisfy a check for `user-123`.
    const url = "https://blendn-media.fly.storage.tigris.dev/profile/user-1234/x.jpg"
    expect(ownedPhotoKey(url, "user-123")).toBeNull()
  })

  it("refuses the bare prefix with no object after it", () => {
    const url = `https://blendn-media.fly.storage.tigris.dev/profile/${USER}/`
    expect(ownedPhotoKey(url, USER)).toBeNull()
  })

  it("refuses traversal, encoded or not", () => {
    for (const key of ["profile/user-123/../../etc/passwd", "profile/user-123/%2e%2e/x"]) {
      expect(ownedPhotoKey(`https://blendn-media.fly.storage.tigris.dev/${key}`, USER)).toBeNull()
    }
  })
})

describe("the size floor", () => {
  it("sits below any real photo and above any blank one", async () => {
    /*
     * A 1000x1000 solid-colour JPEG lands around 5-15 KB; a photograph off any
     * phone is hundreds of KB even after the client compresses it. The floor
     * has to separate those two populations, and a number in the megabytes or
     * the hundreds of bytes would not.
     *
     * This is the whole blank-image check. The alternative was `sharp` for
     * per-channel standard deviation — a native dependency in the Railway image
     * and a full download per photo, to distinguish "blank" from "nearly blank"
     * more precisely than anybody needs.
     */
    const { MIN_PHOTO_BYTES } = await import("@/lib/photos")
    expect(MIN_PHOTO_BYTES).toBeGreaterThan(1_000)
    expect(MIN_PHOTO_BYTES).toBeLessThan(50_000)
  })
})
