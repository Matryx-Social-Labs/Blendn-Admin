/**
 * Media provenance.
 *
 * A presigned PUT hands out write access to a key. Every case here is a way that
 * capability can be turned into something other than "this sponsor's artwork on
 * this sponsor's campaign".
 */

const mockDb = {
  events: { findUnique: jest.fn() },
  organisations: { findFirst: jest.fn() },
  organisation_members: { findMany: jest.fn() },
  event_sponsored_messages: { findUnique: jest.fn(), update: jest.fn() },
  sponsored_creatives: { create: jest.fn() },
  upload_grants: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn(), deleteMany: jest.fn() },
  $transaction: jest.fn(),
}

const mockAuth = jest.fn()
const mockPresign = jest.fn()
const mockHead = jest.fn()

jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/auth", () => ({ getAuth: () => mockAuth() }))
jest.mock("@/lib/audit-log", () => ({ auditLog: jest.fn() }))
jest.mock("@/lib/tigris", () => ({
  isConfigured: () => true,
  getPresignedUploadUrl: (...args: unknown[]) => mockPresign(...args),
  headObject: (...args: unknown[]) => mockHead(...args),
  pinnedUrl: (key: string, version: string | null) =>
    version ? `https://cdn.test/${key}?versionId=${version}` : `https://cdn.test/${key}`,
}))

mockDb.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(mockDb))

import { SPONSORSHIP } from "@/lib/constants"
import { attachCreativeMedia, requestCreativeUpload } from "@/lib/upload-grant-actions"
import { sweepExpiredGrants } from "@/lib/upload-grants"

const EVENT = "11111111-1111-4111-8111-111111111111"
const CAMPAIGN = "22222222-2222-4222-8222-222222222222"
const ORG = "33333333-3333-4333-8333-333333333333"
const OTHER_ORG = "44444444-4444-4444-8444-444444444444"
const USER = "user-1"
const KEY = "sponsored/user-1/1234-abcd-artwork.png"

const image = { filename: "artwork.png", contentType: "image/png", bytes: 400_000 }

function grantRow(over: Record<string, unknown> = {}) {
  mockDb.upload_grants.findUnique.mockResolvedValue({
    id: "grant-1",
    org_id: ORG,
    content_type: "image/png",
    max_bytes: 400_000,
    expires_at: new Date(Date.now() + 10 * 60_000),
    consumed_at: null,
    ...over,
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockDb.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(mockDb))
  mockAuth.mockResolvedValue({ user: { id: USER, role: "sponsor" } })
  mockDb.organisation_members.findMany.mockResolvedValue([{ org_id: ORG }])
  // The grant resolver: one org holds may_sponsor AND the approved placement.
  mockDb.organisations.findFirst.mockResolvedValue({ id: ORG })
  mockPresign.mockResolvedValue({ uploadUrl: "https://put.test/x", publicUrl: "", key: KEY })
  mockDb.event_sponsored_messages.findUnique.mockResolvedValue({
    id: CAMPAIGN,
    event_id: EVENT,
    content: "Stay hydrated",
    sponsor_id: "sponsor-1",
  })
  mockDb.sponsored_creatives.create.mockResolvedValue({ id: "creative-1" })
  mockHead.mockResolvedValue({
    bytes: 380_000,
    contentType: "image/png",
    versionId: "v-abc",
    checksumSha256: "sha-abc",
  })
  grantRow()
})

describe("issuing a grant", () => {
  it("refuses anyone without the sponsor grant", async () => {
    mockDb.organisations.findFirst.mockResolvedValue(null)

    await expect(requestCreativeUpload(EVENT, image)).rejects.toThrow(/forbidden/i)
    expect(mockPresign).not.toHaveBeenCalled()
    expect(mockDb.upload_grants.create).not.toHaveBeenCalled()
  })

  it("records the ceiling on the row, so validation has something to check", async () => {
    await requestCreativeUpload(EVENT, image)

    const data = mockDb.upload_grants.create.mock.calls[0][0].data
    expect(data.org_id).toBe(ORG)
    expect(data.key).toBe(KEY)
    expect(data.content_type).toBe("image/png")
    // The DECLARED size becomes this object's ceiling. Without it the only limit
    // is the format's, and a 400KB logo could arrive as a 5MB one.
    expect(data.max_bytes).toBe(400_000)
    expect(data.expires_at.getTime()).toBeGreaterThan(Date.now())
  })

  it("refuses a file over the format's limit before the upload is even made", async () => {
    await expect(
      requestCreativeUpload(EVENT, { ...image, bytes: SPONSORSHIP.MAX_IMAGE_BYTES + 1 })
    ).rejects.toThrow(/limit is/i)
    expect(mockPresign).not.toHaveBeenCalled()
  })

  it("gives video its own, larger ceiling", async () => {
    await requestCreativeUpload(EVENT, {
      filename: "spot.mp4",
      contentType: "video/mp4",
      bytes: SPONSORSHIP.MAX_IMAGE_BYTES + 1,
    })

    // Over the image limit, under the video one. A single shared ceiling would
    // either refuse every video or let a 100MB "logo" through.
    expect(mockDb.upload_grants.create).toHaveBeenCalledTimes(1)
  })

  it("refuses a format no phone plays inline", async () => {
    for (const contentType of ["image/gif", "video/quicktime", "audio/mpeg", "application/pdf"]) {
      await expect(
        requestCreativeUpload(EVENT, { ...image, contentType })
      ).rejects.toThrow()
    }
    expect(mockPresign).not.toHaveBeenCalled()
  })

  it("asks the storage for a checksum", async () => {
    await requestCreativeUpload(EVENT, image)

    // Signed into the URL, so a client that ignores it gets a rejected PUT
    // rather than a silently unverifiable object.
    expect(mockPresign.mock.calls[0][4]).toEqual({ checksum: true })
    expect(mockPresign.mock.calls[0][2]).toBe("sponsored")
  })
})

describe("redeeming a grant", () => {
  it("refuses a key issued to another organisation", async () => {
    /*
     * A key is a capability. Letting a second organisation redeem one turns an
     * upload URL into a way to attribute somebody else's artwork to your brand,
     * in a room where the brand is the only named participant.
     */
    grantRow({ org_id: OTHER_ORG })

    await expect(attachCreativeMedia(CAMPAIGN, KEY)).rejects.toThrow(/another organisation/i)
    expect(mockDb.sponsored_creatives.create).not.toHaveBeenCalled()
  })

  it("refuses a key we never issued", async () => {
    mockDb.upload_grants.findUnique.mockResolvedValue(null)

    await expect(attachCreativeMedia(CAMPAIGN, "sponsored/someone/else.png")).rejects.toThrow(
      /not issued by us/i
    )
  })

  it("refuses a second redemption of the same key", async () => {
    grantRow({ consumed_at: new Date() })

    await expect(attachCreativeMedia(CAMPAIGN, KEY)).rejects.toThrow(/already been used/i)
  })

  it("refuses an expired grant", async () => {
    grantRow({ expires_at: new Date(Date.now() - 1000) })

    await expect(attachCreativeMedia(CAMPAIGN, KEY)).rejects.toThrow(/expired/i)
  })

  it("refuses an object bigger than it was cleared for", async () => {
    // The declared size was a promise; this is the check that makes it one.
    mockHead.mockResolvedValue({
      bytes: 900_000,
      contentType: "image/png",
      versionId: "v-abc",
      checksumSha256: null,
    })

    await expect(attachCreativeMedia(CAMPAIGN, KEY)).rejects.toThrow(/bigger than/i)
    expect(mockDb.sponsored_creatives.create).not.toHaveBeenCalled()
  })

  it("refuses an object whose type is not what was cleared", async () => {
    mockHead.mockResolvedValue({
      bytes: 380_000,
      contentType: "video/mp4",
      versionId: "v-abc",
      checksumSha256: null,
    })

    await expect(attachCreativeMedia(CAMPAIGN, KEY)).rejects.toThrow(/not the type/i)
  })

  it("refuses an empty object", async () => {
    mockHead.mockResolvedValue({
      bytes: 0,
      contentType: "image/png",
      versionId: null,
      checksumSha256: null,
    })

    await expect(attachCreativeMedia(CAMPAIGN, KEY)).rejects.toThrow(/empty/i)
  })

  it("refuses a file that never arrived", async () => {
    mockHead.mockResolvedValue(null)

    await expect(attachCreativeMedia(CAMPAIGN, KEY)).rejects.toThrow(/cannot find/i)
  })
})

describe("what redemption writes", () => {
  it("pins the object version into the url", async () => {
    const result = await attachCreativeMedia(CAMPAIGN, KEY)

    /*
     * The whole immutability story. A content-addressed key is impossible with a
     * presigned PUT — the key is chosen before the bytes exist — so overwriting
     * the key after review is defeated by serving the version that was reviewed.
     */
    expect(result.mediaUrl).toContain("versionId=v-abc")
    const data = mockDb.sponsored_creatives.create.mock.calls[0][0].data
    expect(data.media_version_id).toBe("v-abc")
    expect(data.media_checksum).toBe("sha-abc")
  })

  it("records no checksum rather than inventing one", async () => {
    mockHead.mockResolvedValue({
      bytes: 380_000,
      contentType: "image/png",
      versionId: "v-abc",
      checksumSha256: null,
    })

    await attachCreativeMedia(CAMPAIGN, KEY)

    // An ETag is an MD5 for a single-part upload and a hash-of-hashes for a
    // multipart one. Writing it into a column called `checksum` would look like
    // provenance and be nothing of the kind.
    expect(mockDb.sponsored_creatives.create.mock.calls[0][0].data.media_checksum).toBeNull()
  })

  it("sends the campaign back to review and switches it off", async () => {
    await attachCreativeMedia(CAMPAIGN, KEY)

    const data = mockDb.event_sponsored_messages.update.mock.calls[0][0].data
    /*
     * The picture is the part an attendee actually looks at. Letting it inherit
     * the text's approval makes review decorative for anyone who can upload —
     * the same hole `creativeEditPatch` closed for the words.
     */
    expect(data.moderation_status).toBe("pending")
    expect(data.is_active).toBe(false)
    expect(data.next_send_at).toBeNull()
  })

  it("adds a revision rather than rewriting the current one", async () => {
    await attachCreativeMedia(CAMPAIGN, KEY)

    // `sponsored_message_sends.creative_id` is onDelete: Restrict so history
    // survives — a send from last night keeps pointing at what it delivered.
    expect(mockDb.sponsored_creatives.create).toHaveBeenCalledTimes(1)
    expect(mockDb.sponsored_creatives.create.mock.calls[0][0].data.message_id).toBe(CAMPAIGN)
  })

  it("marks the grant consumed in the same transaction", async () => {
    await attachCreativeMedia(CAMPAIGN, KEY)

    expect(mockDb.$transaction).toHaveBeenCalledTimes(1)
    const data = mockDb.upload_grants.update.mock.calls[0][0].data
    expect(data.consumed_at).toBeInstanceOf(Date)
    expect(data.version_id).toBe("v-abc")
  })
})

describe("the sweeper", () => {
  it("reclaims only unredeemed, expired grants", async () => {
    mockDb.upload_grants.deleteMany.mockResolvedValue({ count: 3 })
    const now = new Date()

    expect(await sweepExpiredGrants(now)).toBe(3)

    const where = mockDb.upload_grants.deleteMany.mock.calls[0][0].where
    /*
     * A CONSUMED grant is the record of where a live creative's bytes came from.
     * Deleting it would leave `media_version_id` on the creative with nothing to
     * explain it.
     */
    expect(where.consumed_at).toBeNull()
    expect(where.expires_at).toEqual({ lt: now })
  })
})
