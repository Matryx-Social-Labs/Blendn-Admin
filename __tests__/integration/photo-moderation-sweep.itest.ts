/*
 * A photo the vendor could not look at is looked at again (SCRUM-732).
 *
 * `photo_checks.checked = false` was a count on the moderation screen and
 * nothing else: a photo whose check failed once -- OpenAI answering 400
 * "Failed to download image." for an object written a moment earlier -- stayed
 * public and unmoderated for ever. The sweep re-asks, through the same two
 * functions the profile write uses, so a verdict has one meaning wherever it
 * comes from.
 */
jest.mock("@/lib/moderation/openai-moderation", () => ({ checkImageContent: jest.fn() }))
jest.mock("@/lib/tigris", () => ({
  ...jest.requireActual("@/lib/tigris"),
  withdrawFromPublic: jest.fn().mockResolvedValue(undefined),
  // Every object exists unless a test says otherwise.
  headObject: jest.fn().mockResolvedValue({ bytes: 100_000, contentType: "image/jpeg", versionId: null, checksumSha256: null }),
}))

import { checkImageContent } from "@/lib/moderation/openai-moderation"
import { headObject, withdrawFromPublic } from "@/lib/tigris"
import { SWEEP_SETTLE_MS, sweepUnmoderatedPhotos } from "@/lib/photo-sweeper"
import { db, closeDb, makeUser, onboard } from "./helpers"

const bucketHost = `https://${process.env.TIGRIS_BUCKET || "blendn-media"}.fly.storage.tigris.dev`
const urlOf = (userId: string, name: string) => `${bucketHost}/profile/${userId}/${name}`

const users: string[] = []
afterAll(async () => {
  if (users.length) {
    await db.photo_checks.deleteMany({ where: { user_id: { in: users } } })
    await db.profiles.deleteMany({ where: { id: { in: users } } })
    await db.user.deleteMany({ where: { id: { in: users } } })
  }
  await closeDb()
})

const OLD = new Date(Date.now() - 60 * 60_000)
const CLEAN = { checked: true, result: null }
const HIDE = { checked: true, result: { action: "hide", source: "openai_image", categories: { sexual: 0.99 }, confidence: 0.99 } }

/** A person with a photo and its blur, both on the unchecked list since an hour ago. */
async function person() {
  const id = await makeUser("sweep")
  users.push(id)
  await onboard(id)
  const photo = urlOf(id, "main-sealed")
  const blur = urlOf(id, "blur-sealed")
  await db.profiles.update({ where: { id }, data: { photos: [photo], blur_photo: blur } })
  await db.photo_checks.createMany({
    data: [
      { url: photo, user_id: id, checked: false, created_at: OLD },
      { url: blur, user_id: id, checked: false, created_at: OLD },
    ],
  })
  return { id, photo, blur }
}
const checkedOf = async (url: string) => (await db.photo_checks.findUnique({ where: { url } }))?.checked

beforeEach(() => {
  jest.clearAllMocks()
  ;(headObject as jest.Mock).mockResolvedValue({ bytes: 100_000, contentType: "image/jpeg", versionId: null, checksumSha256: null })
})

describe("the unchecked-photo sweep", () => {
  it("checks again a photo and a blur the vendor could not look at, and marks them checked", async () => {
    const p = await person()
    ;(checkImageContent as jest.Mock).mockResolvedValue(CLEAN)
    await sweepUnmoderatedPhotos()
    expect(await checkedOf(p.photo)).toBe(true)
    expect(await checkedOf(p.blur)).toBe(true)
    // Retried inside the call too: this is not the request path.
    expect(checkImageContent).toHaveBeenCalledWith(p.photo, expect.objectContaining({ retries: expect.any(Number) }))
  })

  it("pulls a photo the second look finds unsafe, and its blur, exactly as the profile write's moderation does", async () => {
    const p = await person()
    ;(checkImageContent as jest.Mock).mockImplementation(async (url: string) => (url === p.photo ? HIDE : CLEAN))
    await sweepUnmoderatedPhotos()
    const profile = await db.profiles.findUniqueOrThrow({ where: { id: p.id }, select: { photos: true, blur_photo: true } })
    expect(profile).toEqual({ photos: [], blur_photo: null })
    expect(await db.photo_checks.findUnique({ where: { url: p.photo } })).toMatchObject({ checked: true, hidden: true })
    expect(withdrawFromPublic).toHaveBeenCalled()
  })

  it("clears only the blur when the blur is the unsafe one", async () => {
    const p = await person()
    ;(checkImageContent as jest.Mock).mockImplementation(async (url: string) => (url === p.blur ? HIDE : CLEAN))
    await sweepUnmoderatedPhotos()
    const profile = await db.profiles.findUniqueOrThrow({ where: { id: p.id }, select: { photos: true, blur_photo: true } })
    expect(profile).toEqual({ photos: [p.photo], blur_photo: null })
  })

  it("leaves a photo the vendor still cannot judge on the list for the next pass", async () => {
    const p = await person()
    ;(checkImageContent as jest.Mock).mockResolvedValue({ checked: false, reason: "error" })
    await sweepUnmoderatedPhotos()
    expect(await checkedOf(p.photo)).toBe(false)
    expect(await db.profiles.findUniqueOrThrow({ where: { id: p.id }, select: { photos: true } })).toMatchObject({ photos: [p.photo] })
  })

  it("does not race the write that just made the row: a young one waits for the inline check", async () => {
    const p = await person()
    await db.photo_checks.updateMany({ where: { user_id: p.id }, data: { created_at: new Date(Date.now() - SWEEP_SETTLE_MS / 2) } })
    await sweepUnmoderatedPhotos()
    expect(checkImageContent).not.toHaveBeenCalledWith(p.photo, expect.anything())
    expect(await checkedOf(p.photo)).toBe(false)
  })

  it("drops the row of an object that is gone, without asking the vendor about it", async () => {
    const p = await person()
    ;(headObject as jest.Mock).mockResolvedValue(null)
    await sweepUnmoderatedPhotos()
    expect(await db.photo_checks.findUnique({ where: { url: p.photo } })).toBeNull()
    expect(checkImageContent).not.toHaveBeenCalledWith(p.photo, expect.anything())
  })

  it("never sends the vendor a URL that is not the person's own object", async () => {
    const p = await person()
    const foreign = "https://example.com/not-ours.jpg"
    await db.photo_checks.create({ data: { url: foreign, user_id: p.id, checked: false, created_at: OLD } })
    ;(checkImageContent as jest.Mock).mockResolvedValue(CLEAN)
    await sweepUnmoderatedPhotos()
    expect(checkImageContent).not.toHaveBeenCalledWith(foreign, expect.anything())
    expect(await checkedOf(foreign)).toBe(false)
  })

  it("reports what it settled, not what it selected", async () => {
    await person()
    ;(checkImageContent as jest.Mock).mockResolvedValue({ checked: false, reason: "error" })
    const stuck = await sweepUnmoderatedPhotos()
    expect(stuck.settled).toBe(0)
    ;(checkImageContent as jest.Mock).mockResolvedValue(CLEAN)
    const done = await sweepUnmoderatedPhotos()
    expect(done.settled).toBeGreaterThan(0)
  })
})
