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

describe("the delete route binds the key the way the fetch path does", () => {
  /*
   * `extractKeyFromUrl` -- "useless as a security check" by its own docstring
   * -- parsed the URL for DELETE /uploads, and ownership was `split("/")[1]`.
   * Now the folder-bound validator, with the folder from an allow-list.
   */
  it("accepts own objects in the three deletable folders and nothing else", async () => {
    const { ownedObjectKey } = await import("@/lib/tigris")
    const host = "https://blendn-media.fly.storage.tigris.dev"
    expect(ownedObjectKey(`${host}/chat/${USER}/1-a.jpg`, USER, "chat")).toBe(`chat/${USER}/1-a.jpg`)
    expect(ownedObjectKey(`${host}/events/${USER}/1-a.jpg`, USER, "events")).toBe(`events/${USER}/1-a.jpg`)
    // Somebody else's, a different folder than asked for, a host that merely contains ours.
    expect(ownedObjectKey(`${host}/chat/other/1-a.jpg`, USER, "chat")).toBeNull()
    expect(ownedObjectKey(`${host}/chat/${USER}/1-a.jpg`, USER, "profile")).toBeNull()
    expect(ownedObjectKey(`https://evil.example/?x=blendn-media.fly.storage.tigris.dev/chat/${USER}/a`, USER, "chat")).toBeNull()
  })

  it("the route uses it, and no longer the loose parser", async () => {
    const { readFileSync } = await import("fs")
    const { join } = await import("path")
    const src = readFileSync(join(__dirname, "..", "app/api/mobile/uploads/delete/route.ts"), "utf8")
    expect(src).toMatch(/ownedObjectKey\(url, authUser\.userId, f\)/)
    expect(src).not.toMatch(/extractKeyFromUrl/)
    expect(src).toMatch(/DELETABLE_FOLDERS: UploadFolder\[\] = \["profile", "chat", "events"\]/)
  })
})
