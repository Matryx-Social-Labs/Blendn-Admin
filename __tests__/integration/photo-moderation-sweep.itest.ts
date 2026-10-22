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
  objectPresence: jest.fn().mockResolvedValue("present"),
}))

import { checkImageContent } from "@/lib/moderation/openai-moderation"
import { objectPresence, withdrawFromPublic } from "@/lib/tigris"
import { MAX_ATTEMPTS_PER_DAY_AFTER, PER_USER_SLOTS, SWEEP_SETTLE_MS, sweepUnmoderatedPhotos } from "@/lib/photo-sweeper"
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

// Each test's rows are its own: a leftover pile would sit in front of the next test's queue.
afterEach(() => db.photo_checks.deleteMany({ where: { user_id: { in: users } } }))

beforeEach(() => {
  jest.clearAllMocks()
  ;(objectPresence as jest.Mock).mockResolvedValue("present")
})

describe("the unchecked-photo sweep", () => {
  it("checks again a photo and a blur the vendor could not look at, and marks them checked", async () => {
    const p = await person()
    ;(checkImageContent as jest.Mock).mockResolvedValue(CLEAN)
    await sweepUnmoderatedPhotos()
    expect(await checkedOf(p.photo)).toBe(true)
    expect(await checkedOf(p.blur)).toBe(true)
    // Retried inside the call too: this is not the request path.
    const asked = (checkImageContent as jest.Mock).mock.calls.find(([url]) => url === p.photo)
    expect(asked?.[1]?.retries).toBeGreaterThan(0)
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

  it("drops the row of an object that is confirmed gone and no longer on the profile, without asking the vendor", async () => {
    const p = await person()
    await db.profiles.update({ where: { id: p.id }, data: { photos: [], blur_photo: null } })
    ;(objectPresence as jest.Mock).mockResolvedValue("gone")
    await sweepUnmoderatedPhotos()
    expect(await db.photo_checks.findUnique({ where: { url: p.photo } })).toBeNull()
    expect(checkImageContent).not.toHaveBeenCalledWith(p.photo, expect.anything())
  })

  it("keeps the row of a gone object the profile still points at: a dangling photo is not a judged one", async () => {
    const p = await person()
    ;(objectPresence as jest.Mock).mockResolvedValue("gone")
    await sweepUnmoderatedPhotos()
    expect(await checkedOf(p.photo)).toBe(false)
  })

  it("does not read 'could not tell' as 'gone': a storage error leaves the row for the next pass", async () => {
    const p = await person()
    await db.profiles.update({ where: { id: p.id }, data: { photos: [], blur_photo: null } })
    ;(objectPresence as jest.Mock).mockResolvedValue("unknown")
    await sweepUnmoderatedPhotos()
    expect(await db.photo_checks.findUnique({ where: { url: p.photo } })).not.toBeNull()
    expect(checkImageContent).not.toHaveBeenCalledWith(p.photo, expect.anything())
  })

  it("fails closed on a URL that is not the person's own object: it is pulled from the profile, never sent to the vendor", async () => {
    const p = await person()
    const foreign = "https://example.com/not-ours.jpg"
    await db.profiles.update({ where: { id: p.id }, data: { photos: [foreign, p.photo] } })
    await db.photo_checks.create({ data: { url: foreign, user_id: p.id, checked: false, created_at: OLD } })
    ;(checkImageContent as jest.Mock).mockResolvedValue(CLEAN)
    await sweepUnmoderatedPhotos()
    expect(checkImageContent).not.toHaveBeenCalledWith(foreign, expect.anything())
    expect((await db.profiles.findUniqueOrThrow({ where: { id: p.id }, select: { photos: true } })).photos).toEqual([p.photo])
    expect(await db.photo_checks.findUnique({ where: { url: foreign } })).toMatchObject({ checked: true, hidden: true })
  })

  it("records each attempt, so a row that never gets a verdict can be put behind the ones that might", async () => {
    const p = await person()
    ;(checkImageContent as jest.Mock).mockResolvedValue({ checked: false, reason: "error" })
    await sweepUnmoderatedPhotos()
    await sweepUnmoderatedPhotos()
    const row = await db.photo_checks.findUniqueOrThrow({ where: { url: p.photo } })
    expect(row.attempts).toBe(2)
    expect(row.last_attempted_at).not.toBeNull()
  })

  it("cannot be starved: one person's pile of unjudgeable photos takes a few slots a pass, not the queue", async () => {
    const flooder = await person()
    const many = Array.from({ length: PER_USER_SLOTS * 4 }, (_, i) => urlOf(flooder.id, `extra-${i}-sealed`))
    await db.photo_checks.createMany({ data: many.map((url) => ({ url, user_id: flooder.id, checked: false, created_at: new Date(OLD.getTime() - 1000) })) })
    const honest = await person()
    ;(checkImageContent as jest.Mock).mockImplementation(async (url: string) =>
      url.includes(`/${flooder.id}/`) ? { checked: false, reason: "error" } : CLEAN
    )
    await sweepUnmoderatedPhotos()
    expect(await checkedOf(honest.photo)).toBe(true)
    const asked = (checkImageContent as jest.Mock).mock.calls.filter(([url]) => String(url).includes(`/${flooder.id}/`))
    expect(asked.length).toBeLessThanOrEqual(PER_USER_SLOTS)
  })

  it("is not starved by a pile bigger than any pool the sweep could read: the cap is applied in the query", async () => {
    const flooder = await person()
    // Older than everything else, never attempted: ordered by age alone they would fill any read-ahead window.
    const many = Array.from({ length: 300 }, (_, i) => urlOf(flooder.id, `flood-${i}-sealed`))
    await db.photo_checks.createMany({
      data: many.map((url, i) => ({ url, user_id: flooder.id, checked: false, created_at: new Date(OLD.getTime() - 10_000_000 + i) })),
    })
    const honest = await person()
    ;(checkImageContent as jest.Mock).mockImplementation(async (url: string) =>
      url.includes(`/${flooder.id}/`) ? { checked: false, reason: "error" } : CLEAN
    )
    await sweepUnmoderatedPhotos()
    expect(await checkedOf(honest.photo)).toBe(true)
    const asked = (checkImageContent as jest.Mock).mock.calls.filter(([url]) => String(url).includes(`/${flooder.id}/`))
    expect(asked.length).toBeLessThanOrEqual(PER_USER_SLOTS)
  })

  it("takes the least recently attempted first, so every row of a long queue gets its turn", async () => {
    const flooder = await person()
    // Four failing rows, one slot-set per pass: three passes must reach all of them.
    ;(checkImageContent as jest.Mock).mockResolvedValue({ checked: false, reason: "error" })
    const urls = Array.from({ length: PER_USER_SLOTS + 2 }, (_, i) => urlOf(flooder.id, `q-${i}-sealed`))
    await db.photo_checks.deleteMany({ where: { user_id: flooder.id } })
    // Distinct ages, so that ordering by age alone would pick the same three rows every pass.
    await db.photo_checks.createMany({ data: urls.map((url, i) => ({ url, user_id: flooder.id, checked: false, created_at: new Date(OLD.getTime() + i * 1000) })) })
    await sweepUnmoderatedPhotos()
    await sweepUnmoderatedPhotos()
    const rows = await db.photo_checks.findMany({ where: { user_id: flooder.id } })
    expect(rows.every((r) => r.attempts >= 1)).toBe(true)
  })

  it("backs a row off once it has been tried a lot: not again for a day", async () => {
    const p = await person()
    await db.photo_checks.update({ where: { url: p.photo }, data: { attempts: MAX_ATTEMPTS_PER_DAY_AFTER, last_attempted_at: new Date() } })
    ;(checkImageContent as jest.Mock).mockResolvedValue(CLEAN)
    await sweepUnmoderatedPhotos()
    expect(checkImageContent).not.toHaveBeenCalledWith(p.photo, expect.anything())
    await db.photo_checks.update({ where: { url: p.photo }, data: { last_attempted_at: new Date(Date.now() - 25 * 3_600_000) } })
    await sweepUnmoderatedPhotos()
    expect(await checkedOf(p.photo)).toBe(true)
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
