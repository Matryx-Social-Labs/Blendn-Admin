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

import { CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { getPresignedUploadUrl, sealUpload } from "@/lib/tigris"

const USER = "cmuser0000000000000000001"
const SOURCE = `chat/${USER}/1790641297767-cfg6ta-photo.jpg`

beforeEach(() => send.mockReset())

const sentOf = <T>(type: new (...args: never[]) => T) =>
  send.mock.calls.map(([c]) => c).filter((c): c is T => c instanceof type)

/** What a HEAD says: of the source, and then of the copy (the same, unless the source changed in between). */
function storageHolds(source: object | null, copy: object | null = source) {
  send.mockImplementation(async (command: unknown) => {
    if (command instanceof HeadObjectCommand) {
      const facts = command.input.Key === SOURCE || !command.input.Key?.includes("sealed") ? source : copy
      if (!facts) throw Object.assign(new Error("NotFound"), { name: "NotFound", $metadata: { httpStatusCode: 404 } })
      return facts
    }
    return {}
  })
}

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
  it("copies it to a key of its own with the server's headers, vouches for the copy, and deletes the source", async () => {
    storageHolds({ ContentLength: 120_000, ContentType: "image/jpeg" })
    const sealed = await sealUpload(SOURCE, "chat", USER)

    const [copy] = sentOf(CopyObjectCommand)
    expect(copy.input).toMatchObject({
      CopySource: `blendn-media-test-private/${SOURCE}`,
      // Not the uploader's headers: only content-type was signed, so anything else they sent is theirs.
      MetadataDirective: "REPLACE",
      ContentType: "image/jpeg",
    })
    expect(copy.input.ContentEncoding).toBeUndefined()
    /*
     * And `no-cache`. Tigris's public endpoint keeps serving a deleted object
     * for as long as the header allows: a year left a deleted account's photo
     * up after the erasure, and no header is the storage default, an hour.
     * With `no-cache` a deleted object answered 404 at once (measured on
     * staging, SCRUM-445).
     */
    expect(copy.input.CacheControl).toBe("no-cache")
    const sealedKey = copy.input.Key!
    expect(sealedKey).not.toBe(SOURCE)
    expect(sealedKey.startsWith(`chat/${USER}/`)).toBe(true)
    // The source first, then the copy: the copy is what is vouched for.
    expect(sentOf(HeadObjectCommand).map((h) => h.input.Key)).toEqual([SOURCE, sealedKey])
    // Nothing the upload URL can still write is left for anything to point at.
    expect(sentOf(DeleteObjectCommand).map((d) => d.input.Key)).toEqual([SOURCE])
    expect(sealed).toEqual({
      key: sealedKey,
      url: `https://blendn-media-test-private.fly.storage.tigris.dev/${sealedKey}`,
      bytes: 120_000,
      contentType: "image/jpeg",
    })
  })

  it.each([
    ["larger than the folder allows", { ContentLength: 51 * 1024 * 1024, ContentType: "image/jpeg" }, "too_large"],
    ["a type the folder does not take", { ContentLength: 2_000, ContentType: "text/html" }, "wrong_type"],
    ["empty", { ContentLength: 0, ContentType: "image/jpeg" }, "too_small"],
  ])("refuses a source that is %s before copying a byte", async (_label, head, refused) => {
    storageHolds(head)
    expect(await sealUpload(SOURCE, "chat", USER)).toEqual({ refused })
    expect(sentOf(CopyObjectCommand)).toHaveLength(0)
  })

  it("refuses a copy that changed after the source was checked, and deletes the copy and keeps the source", async () => {
    // Tigris ignores CopySourceIfMatch: the bytes copied can be newer than the ones checked.
    storageHolds({ ContentLength: 120_000, ContentType: "image/jpeg" }, { ContentLength: 60 * 1024 * 1024, ContentType: "image/jpeg" })
    expect(await sealUpload(SOURCE, "chat", USER)).toEqual({ refused: "too_large" })
    const copied = sentOf(CopyObjectCommand)[0].input.Key
    expect(sentOf(DeleteObjectCommand).map((d) => d.input.Key)).toEqual([copied])
  })

  it.each([
    ["an 11 MB photo", { ContentLength: 11 * 1024 * 1024, ContentType: "image/jpeg" }, "too_large"],
    ["a video", { ContentLength: 200_000, ContentType: "video/mp4" }, "wrong_type"],
  ])("holds a profile photo to the profile folder's rules, not chat's: %s", async (_label, head, refused) => {
    storageHolds(head)
    expect(await sealUpload(`profile/${USER}/1-a-me.jpg`, "profile", USER)).toEqual({ refused })
  })

  it("applies a caller's floor: a profile photo below it is refused", async () => {
    storageHolds({ ContentLength: 3_000, ContentType: "image/jpeg" })
    expect(await sealUpload(`profile/${USER}/1-a-me.jpg`, "profile", USER, 8_000)).toEqual({ refused: "too_small" })
    expect(sentOf(CopyObjectCommand)).toHaveLength(0)
  })

  it("says missing when there is nothing there, and copies nothing", async () => {
    storageHolds(null)
    expect(await sealUpload(SOURCE, "chat", USER)).toEqual({ refused: "missing" })
    expect(sentOf(CopyObjectCommand)).toHaveLength(0)
  })

  it("on a storage failure mid-copy, removes whatever copy it left and surfaces the error", async () => {
    send.mockImplementation(async (command: unknown) => {
      if (command instanceof HeadObjectCommand) return { ContentLength: 120_000, ContentType: "image/jpeg" }
      if (command instanceof CopyObjectCommand) throw Object.assign(new Error("socket hang up"), { name: "TimeoutError" })
      return {}
    })
    await expect(sealUpload(SOURCE, "chat", USER)).rejects.toThrow("socket hang up")
    const copied = sentOf(CopyObjectCommand)[0].input.Key
    expect(sentOf(DeleteObjectCommand).map((d) => d.input.Key)).toEqual([copied])
  })

  it("refuses to seal a key outside the caller's own folder", async () => {
    await expect(sealUpload(`chat/someone-else/1-a-x.jpg`, "chat", USER)).rejects.toThrow("outside")
    expect(send).not.toHaveBeenCalled()
  })
})
