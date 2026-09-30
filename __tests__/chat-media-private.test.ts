/*
 * DM and room images are private objects, read through a short-lived signed
 * URL (SCRUM-427).
 *
 * Found on staging: a DM image lived in the public bucket under
 * `chat/<senderId>/`, and an anonymous GET of its URL answered 200, forever.
 * The staging bucket is public as a whole (the per-folder policy does not
 * apply there), so the only fix is the other bucket: measured, the private
 * bucket answers an anonymous GET 403 and a signed one 200.
 */
process.env.TIGRIS_ENDPOINT = "https://fly.storage.tigris.dev"
process.env.TIGRIS_ACCESS_KEY = "test-access"
process.env.TIGRIS_SECRET_KEY = "test-secret"
process.env.TIGRIS_BUCKET = "blendn-media-test"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/db", () => ({ db: {} }))

import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3"
import { bucketFor, deletePrefix, getPresignedUploadUrl, ownedObjectKey, readableUrl } from "@/lib/tigris"
import { resolveMediaFields } from "@/lib/media-response"

const USER = "cmuser0000000000000000001"
const PRIVATE_HOST = "blendn-media-test-private.fly.storage.tigris.dev"
const PUBLIC_HOST = "blendn-media-test.fly.storage.tigris.dev"
const privateUrl = `https://${PRIVATE_HOST}/chat/${USER}/1790000000000-abc123-sealed`
const publicUrl = `https://${PUBLIC_HOST}/profile/${USER}/1790000000000-abc123-sealed`

const signed = (url: string) => new URL(url).searchParams.has("X-Amz-Signature")

describe("chat media goes in the private bucket", () => {
  it("is granted, stored and referenced there", async () => {
    expect(bucketFor("chat")).toBe("blendn-media-test-private")
    const { publicUrl: reference } = await getPresignedUploadUrl("dm.jpg", "image/jpeg", "chat", USER)
    expect(new URL(reference).hostname).toBe(PRIVATE_HOST)
    // A profile photo stays public: a match card must load without a round trip.
    expect(bucketFor("profile")).toBe("blendn-media-test")
  })

  it("is still the sender's own upload when the URL is on the private host", () => {
    expect(ownedObjectKey(privateUrl, USER, "chat")).toBe(`chat/${USER}/1790000000000-abc123-sealed`)
    expect(ownedObjectKey(privateUrl, "someone-else", "chat")).toBeNull()
  })
})

describe("readableUrl", () => {
  it("signs a private-bucket URL, for that bucket and key, for 15 minutes", async () => {
    const url = await readableUrl(privateUrl)
    expect(signed(url)).toBe(true)
    expect(url).toContain(`blendn-media-test-private/chat/${USER}/1790000000000-abc123-sealed`)
    expect(new URL(url).searchParams.get("X-Amz-Expires")).toBe("900")
  })

  it("signs chat media only: a venue claim's document on the same bucket is never signed for a reader", async () => {
    // A legacy free-form metadata row could name any private key; the reader must not get a key to it.
    const claim = `https://${PRIVATE_HOST}/claims/${USER}/1790000000000-abc123-licence.pdf`
    expect(await readableUrl(claim)).toBe(claim)
    const climb = `https://${PRIVATE_HOST}/chat/${USER}/../../claims/x/licence.pdf`
    expect(signed(await readableUrl(climb))).toBe(false)
  })

  it("never throws: a private URL it cannot sign comes back bare, which the bucket answers 403", async () => {
    const broken = `https://${PRIVATE_HOST}/chat/${USER}/%E0%A4%A`
    await expect(readableUrl(broken)).resolves.toBe(broken)
  })

  it("leaves a public-bucket URL, an outside URL and a non-string alone", async () => {
    expect(await readableUrl(publicUrl)).toBe(publicUrl)
    expect(await readableUrl("https://example.com/a.jpg")).toBe("https://example.com/a.jpg")
    expect(await readableUrl("")).toBe("")
  })
})

describe("every response signs chat media on its way out", () => {
  it("signs mediaUrl and media_url wherever they sit, and nothing else", async () => {
    const out = await resolveMediaFields({
      message: { id: "m1", metadata: { mediaUrl: privateUrl } },
      messages: [{ id: "d1", mediaUrl: privateUrl }, { id: "d2", media_url: privateUrl }],
      sponsored: { mediaUrl: publicUrl },
      image: publicUrl,
    })
    expect(signed(out.message.metadata.mediaUrl)).toBe(true)
    expect(signed(out.messages[0].mediaUrl!)).toBe(true)
    expect(signed(out.messages[1].media_url!)).toBe(true)
    // Public media (sponsored artwork, a profile image) is untouched.
    expect(out.sponsored.mediaUrl).toBe(publicUrl)
    expect(out.image).toBe(publicUrl)
  })
})

describe("deleting one chat upload", () => {
  it("deletes it from both buckets, since an older one may still be in the public bucket", async () => {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3")
    const send = jest.spyOn(S3Client.prototype, "send").mockImplementation(async () => ({}))
    const { deleteFile } = await import("@/lib/tigris")
    await deleteFile(`chat/${USER}/1-a.jpg`)
    const deletes = send.mock.calls.map(([c]) => c as unknown).filter((c): c is InstanceType<typeof DeleteObjectCommand> => c instanceof DeleteObjectCommand)
    expect(deletes.map((c) => c.input.Bucket).sort()).toEqual(["blendn-media-test", "blendn-media-test-private"])
    send.mockRestore()
  })
})

describe("erasing a person's chat uploads", () => {
  it("sweeps the private bucket and the public one, where chat media lived before SCRUM-427", async () => {
    const send = jest.spyOn(S3Client.prototype, "send").mockImplementation(async () => ({ Contents: [], IsTruncated: false }))
    await deletePrefix(`chat/${USER}/`)
    const listed = send.mock.calls.map(([c]) => c as unknown).filter((c): c is ListObjectsV2Command => c instanceof ListObjectsV2Command)
    expect(listed.map((c) => c.input.Bucket).sort()).toEqual(["blendn-media-test", "blendn-media-test-private"])
    send.mockRestore()
  })

  it("sweeps both buckets for a profile prefix: pulled photos are kept in the private one (SCRUM-479)", async () => {
    const send = jest.spyOn(S3Client.prototype, "send").mockImplementation(async () => ({ Contents: [], IsTruncated: false }))
    await deletePrefix(`profile/${USER}/`)
    const listed = send.mock.calls.map(([c]) => c as unknown).filter((c): c is ListObjectsV2Command => c instanceof ListObjectsV2Command)
    expect(listed.map((c) => c.input.Bucket)).toEqual(["blendn-media-test", "blendn-media-test-private"])
    send.mockRestore()
  })
})

describe("the paths that do not go through a response", () => {
  it("a DM's socket copy carries a signed media URL", async () => {
    const emit = jest.fn()
    const room = { to: () => room, emit }
    ;(globalThis as { __blendnSocketIo?: unknown }).__blendnSocketIo = { to: () => room }
    const { emitPrivateMessage } = await import("@/lib/socket-server")
    emitPrivateMessage("c1", "r1", {
      id: "d1", conversationId: "c1", senderId: USER, sender: { id: USER, name: null, image: null },
      text: null, mediaUrl: privateUrl, mediaType: "image", isRead: false, createdAt: new Date(),
    })
    for (let i = 0; i < 20 && emit.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
    const [, payload] = emit.mock.calls[0]
    expect(signed(payload.message.mediaUrl)).toBe(true)
    // A text DM still goes out, with no media.
    emitPrivateMessage("c1", "r1", {
      id: "d2", conversationId: "c1", senderId: USER, sender: { id: USER, name: null, image: null },
      text: "hi", mediaUrl: null, mediaType: null, isRead: false, createdAt: new Date(),
    })
    for (let i = 0; i < 20 && emit.mock.calls.length < 2; i++) await new Promise((r) => setTimeout(r, 10))
    expect(emit.mock.calls[1][1].message).toMatchObject({ id: "d2", text: "hi", mediaUrl: null })
    delete (globalThis as { __blendnSocketIo?: unknown }).__blendnSocketIo
  })

  it("the image the moderator scans is fetched through a signed URL", async () => {
    jest.resetModules()
    const checkImageContent = jest.fn().mockResolvedValue({ checked: true, result: { action: "allow" } })
    jest.doMock("@/lib/moderation/openai-moderation", () => ({
      checkTextContent: jest.fn().mockResolvedValue({ checked: true, result: { action: "allow" } }),
      checkImageContent,
    }))
    jest.doMock("@/lib/moderation/actions", () => ({
      hideMessage: jest.fn(), flagForReview: jest.fn(), checkAndAutoMute: jest.fn(), recordExamined: jest.fn(),
    }))
    const { moderateMessage } = await import("@/lib/moderation")
    await moderateMessage("m1", "look", "image", USER, "g1", privateUrl)
    expect(checkImageContent).toHaveBeenCalledTimes(1)
    expect(signed(checkImageContent.mock.calls[0][0])).toBe(true)
  })
})
