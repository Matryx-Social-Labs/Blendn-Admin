/*
 * An upload URL binds its content type, and an attached object is a copy
 * nobody can write to (SCRUM-425).
 *
 * Found on staging: the presigned PUT signed only `host`, so its holder could
 * store an HTML page served back as text/html, and could overwrite a photo
 * after it was attached and moderated. Measured against the staging bucket
 * before this was written: Tigris refuses a PUT whose content-type differs
 * from a signed one (403), and it IGNORES `CopySourceIfMatch` (a copy with a
 * stale ETag still copied the new bytes) — so the seal checks the copy, not
 * the source.
 *
 * Since SCRUM-626 the copy is not a storage-side copy: the seal reads the
 * upload, strips its metadata (a phone photo says where it was taken) and
 * writes what is left, so what was checked is exactly what is stored.
 */
process.env.TIGRIS_ENDPOINT = "https://fly.storage.tigris.dev"
process.env.TIGRIS_ACCESS_KEY = "test-access"
process.env.TIGRIS_SECRET_KEY = "test-secret"
process.env.TIGRIS_BUCKET = "blendn-media-test"

const send = jest.fn()
jest.mock("@aws-sdk/client-s3", () => {
  const actual = jest.requireActual("@aws-sdk/client-s3")
  return { ...actual, S3Client: jest.fn().mockImplementation(() => ({ send, config: {} })) }
})
jest.mock("@aws-sdk/s3-request-presigner", () => {
  const actual = jest.requireActual("@aws-sdk/s3-request-presigner")
  return { getSignedUrl: jest.fn(actual.getSignedUrl) }
})

import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { getMaxFileSize, getPresignedUploadUrl, sealedChatKey, sealUpload, validateContentType } from "@/lib/tigris"
import { bytesOf, has, JPEG_WITH_GPS, METADATA, PNG_WITH_GPS } from "./support/gps-photos"

const USER = "cmuser0000000000000000001"
const SOURCE = `chat/${USER}/1790641297767-cfg6ta-photo.jpg`

beforeEach(() => send.mockReset())

const sentOf = <T>(type: new (...args: never[]) => T) =>
  send.mock.calls.map(([c]) => c).filter((c): c is T => c instanceof type)

const PHOTO = bytesOf(JPEG_WITH_GPS)
const TEN_MB = 10 * 1024 * 1024

/** What a HEAD of the upload says, and the bytes a GET of it reads (the same photo, unless it changed in between). */
function storageHolds(head: object | null, body: Uint8Array = PHOTO) {
  send.mockImplementation(async (command: unknown) => {
    if (command instanceof HeadObjectCommand) {
      if (!head) throw Object.assign(new Error("NotFound"), { name: "NotFound", $metadata: { httpStatusCode: 404 } })
      return head
    }
    if (command instanceof GetObjectCommand) return { Body: { transformToByteArray: async () => body } }
    return {}
  })
}

const written = () => sentOf(PutObjectCommand).map((p) => p.input)

describe("the upload URL", () => {
  it("signs the content type it was granted for", async () => {
    // The real presigner, against a real client: the signature is the thing under test.
    const real = new (jest.requireActual("@aws-sdk/client-s3").S3Client)({
      endpoint: process.env.TIGRIS_ENDPOINT,
      region: "auto",
      credentials: { accessKeyId: "test-access", secretAccessKey: "test-secret" },
      forcePathStyle: true,
    })
    ;(getSignedUrl as jest.Mock).mockImplementationOnce((_client, command, options) =>
      jest.requireActual("@aws-sdk/s3-request-presigner").getSignedUrl(real, command, options)
    )
    const { uploadUrl } = await getPresignedUploadUrl("photo.jpg", "image/jpeg", "chat", USER)
    expect(new URL(uploadUrl).searchParams.get("X-Amz-SignedHeaders")).toBe("content-type;host")
  })
})

describe("sealing an upload", () => {
  it("writes the photo, without its location, to a key of its own with the server's headers, and deletes the upload", async () => {
    storageHolds({ ContentLength: PHOTO.length, ContentType: "image/jpeg" })
    const sealed = await sealUpload(SOURCE, "chat", USER)

    // Read once, and no further than the folder's ceiling: the upload can grow after the HEAD.
    expect(sentOf(GetObjectCommand).map((g) => g.input)).toEqual([
      { Bucket: "blendn-media-test-private", Key: SOURCE, Range: `bytes=0-${TEN_MB}` },
    ])
    const [put] = written()
    // The type the bytes are, not whatever else the uploader sent: only content-type was signed.
    expect(put).toMatchObject({ Bucket: "blendn-media-test-private", ContentType: "image/jpeg" })
    expect(put.ContentEncoding).toBeUndefined()
    /*
     * The stored copy carries no GPS block, no EXIF, no comment (SCRUM-626):
     * a DM photo handed the recipient where the sender was standing.
     */
    const stored = put.Body as Uint8Array
    expect(METADATA.filter((m) => has(PHOTO, m)).length).toBeGreaterThanOrEqual(3)
    expect(METADATA.filter((m) => has(stored, m))).toEqual([])
    /*
     * And `no-cache`. Tigris's public endpoint keeps serving a deleted object
     * for as long as the header allows: a year left a deleted account's photo
     * up after the erasure, and no header is the storage default, an hour.
     * With `no-cache` a deleted object answered 404 at once (measured on
     * staging, SCRUM-445).
     */
    expect(put.CacheControl).toBe("no-cache")
    const sealedKey = put.Key!
    expect(sealedKey).not.toBe(SOURCE)
    /*
     * No user id in a chat copy's key (SCRUM-448). The signed URL shows its
     * path to everyone who sees the message, so `chat/<id>/…` let someone in
     * two rooms with a person match that person's images across both.
     */
    expect(sealedKey).toMatch(/^chat\/sealed\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(sealedKey).not.toContain(USER)
    // Nor in its metadata: a GET on the signed URL returns x-amz-meta-* to every viewer.
    expect(put.Metadata).toEqual({})
    // What was written is what was checked: there is no copy to HEAD.
    expect(sentOf(HeadObjectCommand).map((h) => h.input.Key)).toEqual([SOURCE])
    // Nothing the upload URL can still write is left for anything to point at.
    expect(sentOf(DeleteObjectCommand).map((d) => d.input.Key)).toEqual([SOURCE])
    expect(sealed).toEqual({
      key: sealedKey,
      url: `https://blendn-media-test-private.fly.storage.tigris.dev/${sealedKey}`,
      bytes: stored.length,
      contentType: "image/jpeg",
    })
  })

  it("stores the type the bytes are: a PNG uploaded as a JPEG is kept as a PNG", async () => {
    storageHolds({ ContentLength: bytesOf(PNG_WITH_GPS).length, ContentType: "image/jpeg" }, bytesOf(PNG_WITH_GPS))
    expect(await sealUpload(SOURCE, "chat", USER)).toMatchObject({ contentType: "image/png" })
    expect(written()[0].ContentType).toBe("image/png")
  })

  it.each([
    ["larger than the folder allows", { ContentLength: TEN_MB + 1, ContentType: "image/jpeg" }, "too_large"],
    ["a type the folder does not take", { ContentLength: 2_000, ContentType: "text/html" }, "wrong_type"],
    // Photos only, and no GIF (R9): a video, a GIF or a voice note is not one.
    ["a video", { ContentLength: 200_000, ContentType: "video/mp4" }, "wrong_type"],
    ["a GIF", { ContentLength: 2_000, ContentType: "image/gif" }, "wrong_type"],
    ["empty", { ContentLength: 0, ContentType: "image/jpeg" }, "too_small"],
  ])("refuses an upload that is %s before reading a byte, and keeps it", async (_label, head, refused) => {
    storageHolds(head)
    expect(await sealUpload(SOURCE, "chat", USER)).toEqual({ refused })
    expect(sentOf(GetObjectCommand)).toHaveLength(0)
    expect(written()).toHaveLength(0)
    expect(sentOf(DeleteObjectCommand)).toHaveLength(0)
  })

  it.each(["profile", "chat"] as const)("lets %s take a JPEG, PNG or WebP and nothing else", (folder) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "video/mp4", "video/quicktime", "audio/mpeg", "audio/mp4", "application/pdf"]
      .filter((type) => validateContentType(type, folder))
    expect(allowed).toEqual(["image/jpeg", "image/png", "image/webp"])
    expect(getMaxFileSize(folder)).toBe(TEN_MB)
  })

  it("says missing when the upload is gone between the HEAD and the read, and writes nothing", async () => {
    send.mockImplementation(async (command: unknown) => {
      if (command instanceof HeadObjectCommand) return { ContentLength: PHOTO.length, ContentType: "image/jpeg" }
      if (command instanceof GetObjectCommand) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } })
      return {}
    })
    expect(await sealUpload(SOURCE, "chat", USER)).toEqual({ refused: "missing" })
    expect(written()).toHaveLength(0)
  })

  it("refuses an upload that grew after the HEAD, writes nothing, and keeps the upload", async () => {
    // The ranged read stops one byte past the ceiling, which is how a grown upload shows.
    storageHolds({ ContentLength: PHOTO.length, ContentType: "image/jpeg" }, new Uint8Array(TEN_MB + 1))
    expect(await sealUpload(SOURCE, "chat", USER)).toEqual({ refused: "too_large" })
    expect(written()).toHaveLength(0)
    expect(sentOf(DeleteObjectCommand)).toHaveLength(0)
  })

  it.each([
    ["an HTML page", new Uint8Array(Buffer.from("<html><script>alert(1)</script></html>"))],
    ["a photo cut off before its end", PHOTO.subarray(0, 600)],
  ])("refuses %s uploaded as image/jpeg, writes nothing, and keeps the upload", async (_label, body) => {
    storageHolds({ ContentLength: body.length, ContentType: "image/jpeg" }, body)
    expect(await sealUpload(SOURCE, "chat", USER)).toEqual({ refused: "wrong_type" })
    expect(written()).toHaveLength(0)
    expect(sentOf(DeleteObjectCommand)).toHaveLength(0)
  })

  it.each([
    ["an 11 MB photo", { ContentLength: 11 * 1024 * 1024, ContentType: "image/jpeg" }, "too_large"],
    ["a video", { ContentLength: 200_000, ContentType: "video/mp4" }, "wrong_type"],
  ])("holds a profile photo to the profile folder's rules: %s", async (_label, head, refused) => {
    storageHolds(head)
    expect(await sealUpload(`profile/${USER}/1-a-me.jpg`, "profile", USER)).toEqual({ refused })
  })

  it("strips a profile photo too: it is public, so its location would be anybody's", async () => {
    storageHolds({ ContentLength: PHOTO.length, ContentType: "image/jpeg" })
    await sealUpload(`profile/${USER}/1-a-me.jpg`, "profile", USER)
    expect(METADATA.filter((m) => has(written()[0].Body as Uint8Array, m))).toEqual([])
  })

  it("names the chat copy so sealedChatKey reads it back, and nothing looser (SCRUM-448)", async () => {
    storageHolds({ ContentLength: PHOTO.length, ContentType: "image/jpeg" })
    const sealed = await sealUpload(SOURCE, "chat", USER)
    if (!("url" in sealed)) throw new Error("expected a sealed copy")
    expect(sealedChatKey(sealed.url)).toBe(sealed.key)
    const host = "https://blendn-media-test-private.fly.storage.tigris.dev"
    for (const key of ["chat/sealed/not-a-uuid", `${sealed.key}/x`, `chat/${USER}/1-a-sealed`, sealed.key.toUpperCase()]) {
      expect(sealedChatKey(`${host}/${key}`)).toBeNull()
    }
    expect(sealedChatKey(`https://example.com/${sealed.key}`)).toBeNull()
  })

  it("keeps a profile copy under its owner's prefix: a profile is not pseudonymous", async () => {
    storageHolds({ ContentLength: PHOTO.length, ContentType: "image/jpeg" })
    await sealUpload(`profile/${USER}/1-a-me.jpg`, "profile", USER)
    expect(written()[0].Key!.startsWith(`profile/${USER}/`)).toBe(true)
    expect(written()[0].Metadata).toEqual({ "uploaded-by": USER })
  })

  it("applies a caller's floor: a profile photo below it is refused", async () => {
    storageHolds({ ContentLength: 3_000, ContentType: "image/jpeg" })
    expect(await sealUpload(`profile/${USER}/1-a-me.jpg`, "profile", USER, 8_000)).toEqual({ refused: "too_small" })
    expect(written()).toHaveLength(0)
  })

  it("applies a caller's ceiling: a blurred photo the size of a real one is refused before it is read (SCRUM-476)", async () => {
    storageHolds({ ContentLength: 120_000, ContentType: "image/jpeg" })
    expect(await sealUpload(`profile/${USER}/1-a-blur.jpg`, "profile", USER, 1, 4_000)).toEqual({ refused: "too_large" })
    expect(sentOf(GetObjectCommand)).toHaveLength(0)
  })

  it("says missing when there is nothing there, and reads nothing", async () => {
    storageHolds(null)
    expect(await sealUpload(SOURCE, "chat", USER)).toEqual({ refused: "missing" })
    expect(sentOf(GetObjectCommand)).toHaveLength(0)
  })

  it("on a storage failure mid-write, removes whatever copy it left and surfaces the error", async () => {
    send.mockImplementation(async (command: unknown) => {
      if (command instanceof HeadObjectCommand) return { ContentLength: PHOTO.length, ContentType: "image/jpeg" }
      if (command instanceof GetObjectCommand) return { Body: { transformToByteArray: async () => PHOTO } }
      if (command instanceof PutObjectCommand) throw Object.assign(new Error("socket hang up"), { name: "TimeoutError" })
      return {}
    })
    await expect(sealUpload(SOURCE, "chat", USER)).rejects.toThrow("socket hang up")
    expect(sentOf(DeleteObjectCommand).map((d) => d.input.Key)).toEqual([written()[0].Key])
  })

  it("refuses to seal a key outside the caller's own folder", async () => {
    await expect(sealUpload(`chat/someone-else/1-a-x.jpg`, "chat", USER)).rejects.toThrow("outside")
    expect(send).not.toHaveBeenCalled()
  })
})
