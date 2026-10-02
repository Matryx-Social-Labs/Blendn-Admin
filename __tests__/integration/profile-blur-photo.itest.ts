import { NextRequest } from "next/server"

/*
 * `blur_photo` is written, and only as the caller's own small sealed upload
 * (SCRUM-476).
 *
 * The PUT's schema accepted `blur_photo` and the handler dropped it, so the
 * blurred picture a viewer who has not identified someone is meant to see was
 * null for every real account. Written as a free URL it would have been worse:
 * anyone could point every viewer's card at any image. So it is sealed like a
 * photo, capped at a size that is a blur and not a photo, moderated, and cleared
 * whenever the primary photo it was made from changes or is pulled.
 */
process.env.MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("next/server", () => ({ ...jest.requireActual("next/server"), after: jest.fn() }))
jest.mock("@/lib/moderation/openai-moderation", () => ({ checkImageContent: jest.fn() }))
/** Object sizes by name: a "blur" is 2 KB, the two edge names sit either side of 4 KB, anything else is a photo. */
jest.mock("@/lib/tigris", () => ({
  ...jest.requireActual("@/lib/tigris"),
  // A pulled blur leaves the public bucket (SCRUM-479); not against real storage here.
  withdrawFromPublic: jest.fn().mockResolvedValue(undefined),
  // A replaced or cleared blur leaves storage (SCRUM-520); not against real storage here.
  deleteFile: jest.fn().mockResolvedValue(undefined),
  sealUpload: jest.fn(async (key: string, _folder: string, userId: string, minBytes = 1, maxBytes = Infinity) => {
    const name = key.split("/").pop()!
    const bytes = name.includes("blur-edge") ? 4_000 : name.includes("blur-over") ? 4_001 : name.includes("blur") ? 2_000 : 120_000
    if (bytes < minBytes) return { refused: "too_small" }
    if (bytes > maxBytes) return { refused: "too_large" }
    return {
      key: `profile/${userId}/sealed-${name}`,
      url: `https://${process.env.TIGRIS_BUCKET || "blendn-media"}.fly.storage.tigris.dev/profile/${userId}/sealed-${name}`,
      bytes,
      contentType: "image/jpeg",
    }
  }),
}))

import { after } from "next/server"
import { checkImageContent } from "@/lib/moderation/openai-moderation"
import { signAccessToken } from "@/lib/mobile-auth"
import { moderateBlurPhoto, moderateProfilePhoto } from "@/lib/photos"
import { deleteFile, sealUpload } from "@/lib/tigris"
import { db, closeDb, makeUser, onboard } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const profileRoute = require("@/app/api/mobile/profiles/[userId]/route") as
  typeof import("@/app/api/mobile/profiles/[userId]/route")

const users: string[] = []
afterAll(async () => {
  if (users.length) {
    await db.photo_checks.deleteMany({ where: { user_id: { in: users } } })
    await db.profiles.deleteMany({ where: { id: { in: users } } })
    await db.user.deleteMany({ where: { id: { in: users } } })
  }
  await closeDb()
})

const bucketHost = `https://${process.env.TIGRIS_BUCKET || "blendn-media"}.fly.storage.tigris.dev`
const upload = (userId: string, name: string) => `${bucketHost}/profile/${userId}/1790641297767-cfg6ta-${name}`
const sealedOf = (userId: string, name: string) => `${bucketHost}/profile/${userId}/sealed-1790641297767-cfg6ta-${name}`

async function person() {
  const id = await makeUser("blur")
  users.push(id)
  await onboard(id)
  const { email } = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  const token = signAccessToken(id, email)
  const put = (body: object) =>
    profileRoute.PUT(
      new NextRequest(`http://localhost/api/mobile/profiles/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ userId: id }) }
    )
  const view = (targetId: string) =>
    profileRoute.GET(
      new NextRequest(`http://localhost/api/mobile/profiles/${targetId}`, { headers: { authorization: `Bearer ${token}` } }),
      { params: Promise.resolve({ userId: targetId }) }
    )
  return { id, put, view }
}

const codeOf = async (res: Response) => ((await res.json()) as { errorCode?: string }).errorCode

/** Runs what the PUT handed to `after()`, as the server would once the response is sent. */
const runAfter = () => Promise.all((after as jest.Mock).mock.calls.map(([fn]) => fn()))

const blurOf = async (id: string) =>
  (await db.profiles.findUniqueOrThrow({ where: { id }, select: { blur_photo: true } })).blur_photo

/** A profile with one photo and its blur, both sealed. */
async function withBlur() {
  const p = await person()
  expect((await p.put({ photos: [upload(p.id, "a.jpg")], blur_photo: upload(p.id, "a-blur.jpg") })).status).toBe(200)
  expect(await blurOf(p.id)).toBe(sealedOf(p.id, "a-blur.jpg"))
  return p
}

beforeEach(() => jest.clearAllMocks())

describe("writing the blurred photo", () => {
  it("stores the caller's own upload as its sealed copy, and serves it to a stranger instead of the photos", async () => {
    const p = await withBlur()
    const stranger = await person()

    const res = await stranger.view(p.id)
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.profile.blurPhoto).toBe(sealedOf(p.id, "a-blur.jpg"))
    expect(data.profile.photos).toBeUndefined()
    // Screened like a photo, after the response, and on the same list until it is.
    expect(after).toHaveBeenCalledTimes(2)
    const check = await db.photo_checks.findUniqueOrThrow({ where: { url: sealedOf(p.id, "a-blur.jpg") } })
    expect(check).toMatchObject({ user_id: p.id, checked: false })
  })

  it("refuses a URL that is not the caller's own upload, and stores nothing", async () => {
    const p = await person()
    const other = await person()
    expect((await p.put({ photos: [upload(p.id, "a.jpg")] })).status).toBe(200)

    for (const url of [upload(other.id, "x-blur.jpg"), "https://example.com/anyone-blur.jpg"]) {
      const res = await p.put({ blur_photo: url })
      expect(res.status).toBe(400)
      expect(await codeOf(res)).toBe("not_ours")
    }
    expect(await blurOf(p.id)).toBeNull()
  })

  it("refuses a file too large to be a blur: a sharp photo is not a blur of one", async () => {
    const p = await person()
    expect((await p.put({ photos: [upload(p.id, "a.jpg")] })).status).toBe(200)

    const res = await p.put({ blur_photo: upload(p.id, "a-sharp.jpg") })
    expect(res.status).toBe(400)
    expect(await codeOf(res)).toBe("too_large")
    expect(await blurOf(p.id)).toBeNull()
  })

  it("draws the line at 4 KB: 4,000 bytes is a blur, 4,001 is not", async () => {
    const p = await person()
    expect((await p.put({ photos: [upload(p.id, "a.jpg")] })).status).toBe(200)
    expect((await p.put({ blur_photo: upload(p.id, "a-blur-over.jpg") })).status).toBe(400)
    expect((await p.put({ blur_photo: upload(p.id, "a-blur-edge.jpg") })).status).toBe(200)
    expect(await blurOf(p.id)).toBe(sealedOf(p.id, "a-blur-edge.jpg"))
  })

  it("refuses a bad blur before sealing the photos sent with it, so those uploads can be sent again", async () => {
    const p = await person()
    const res = await p.put({ photos: [upload(p.id, "a.jpg")], blur_photo: upload(p.id, "a-sharp.jpg") })
    expect(res.status).toBe(400)
    // Only the blur was looked at; the photo's upload is untouched and nothing was stored.
    expect((sealUpload as jest.Mock).mock.calls.map(([key]) => key.split("/").pop())).toEqual(["1790641297767-cfg6ta-a-sharp.jpg"])
    const profile = await db.profiles.findUniqueOrThrow({ where: { id: p.id }, select: { photos: true, blur_photo: true } })
    expect(profile).toEqual({ photos: [], blur_photo: null })
  })

  it("refuses a blur on a profile with no photo to be a blur of", async () => {
    const p = await person()
    const res = await p.put({ blur_photo: upload(p.id, "a-blur.jpg") })
    expect(res.status).toBe(400)
    expect(await codeOf(res)).toBe("no_photo")
    expect(sealUpload).not.toHaveBeenCalled()
    expect(await blurOf(p.id)).toBeNull()
  })

  it("does not copy the stored blur again when a save sends it back unchanged", async () => {
    const p = await withBlur()
    ;(sealUpload as jest.Mock).mockClear()
    expect((await p.put({ blur_photo: sealedOf(p.id, "a-blur.jpg"), bio: "unchanged blur" })).status).toBe(200)
    expect(sealUpload).not.toHaveBeenCalled()
    expect(await blurOf(p.id)).toBe(sealedOf(p.id, "a-blur.jpg"))
  })

  it("clears it on an explicit null", async () => {
    const p = await withBlur()
    expect((await p.put({ blur_photo: null })).status).toBe(200)
    expect(await blurOf(p.id)).toBeNull()
  })
})

describe("a blur outlives nothing it was made from", () => {
  it("keeps it through a save that touches neither photos nor the blur", async () => {
    // Such a save does not read the stored photos, so "no primary" must not be inferred from it.
    const p = await withBlur()
    expect((await p.put({ bio: "only the bio" })).status).toBe(200)
    expect(await blurOf(p.id)).toBe(sealedOf(p.id, "a-blur.jpg"))
  })

  it("keeps it when a photo is added behind the primary", async () => {
    const p = await withBlur()
    expect((await p.put({ photos: [sealedOf(p.id, "a.jpg"), upload(p.id, "b.jpg")] })).status).toBe(200)
    expect(await blurOf(p.id)).toBe(sealedOf(p.id, "a-blur.jpg"))
  })

  it("clears it when a different photo becomes the primary without a blur of its own", async () => {
    const p = await withBlur()
    expect((await p.put({ photos: [sealedOf(p.id, "a.jpg"), upload(p.id, "b.jpg")] })).status).toBe(200)
    expect((await p.put({ photos: [sealedOf(p.id, "b.jpg"), sealedOf(p.id, "a.jpg")] })).status).toBe(200)
    expect(await blurOf(p.id)).toBeNull()
  })

  it("clears it on a new primary even when the save sends the old blur back: that blur is of the old photo", async () => {
    const p = await withBlur()
    expect((await p.put({ photos: [sealedOf(p.id, "a.jpg"), upload(p.id, "b.jpg")] })).status).toBe(200)
    const res = await p.put({ photos: [sealedOf(p.id, "b.jpg"), sealedOf(p.id, "a.jpg")], blur_photo: sealedOf(p.id, "a-blur.jpg") })
    expect(res.status).toBe(200)
    expect(await blurOf(p.id)).toBeNull()
  })

  it("takes the new blur when the new primary arrives with one", async () => {
    const p = await withBlur()
    const res = await p.put({ photos: [upload(p.id, "b.jpg")], blur_photo: upload(p.id, "b-blur.jpg") })
    expect(res.status).toBe(200)
    expect(await blurOf(p.id)).toBe(sealedOf(p.id, "b-blur.jpg"))
  })

  it("clears it when every photo is deleted", async () => {
    const p = await withBlur()
    expect((await p.put({ photos: [] })).status).toBe(200)
    expect(await blurOf(p.id)).toBeNull()
  })

  it("clears it when moderation pulls the primary, and keeps it when moderation pulls another photo", async () => {
    const hide = { checked: true, result: { action: "hide" } }
    const p = await withBlur()
    expect((await p.put({ photos: [sealedOf(p.id, "a.jpg"), upload(p.id, "b.jpg")] })).status).toBe(200)

    ;(checkImageContent as jest.Mock).mockResolvedValue(hide)
    await moderateProfilePhoto(sealedOf(p.id, "b.jpg"), p.id)
    expect(await blurOf(p.id)).toBe(sealedOf(p.id, "a-blur.jpg"))

    await moderateProfilePhoto(sealedOf(p.id, "a.jpg"), p.id)
    expect(await blurOf(p.id)).toBeNull()
  })

  it("clears it when moderation flags the blur the PUT stored", async () => {
    const p = await withBlur()
    ;(after as jest.Mock).mockClear()
    // A new blur for the same photo: after() gets its moderation, and the old blur's deletion (SCRUM-520) --
    // which deletes nothing here, because the old blur was never judged.
    expect((await p.put({ blur_photo: upload(p.id, "a2-blur.jpg") })).status).toBe(200)
    expect(after).toHaveBeenCalledTimes(2)

    ;(checkImageContent as jest.Mock).mockResolvedValue({ checked: true, result: { action: "allow" } })
    await runAfter()
    expect(await blurOf(p.id)).toBe(sealedOf(p.id, "a2-blur.jpg"))
    expect((await db.photo_checks.findUniqueOrThrow({ where: { url: sealedOf(p.id, "a2-blur.jpg") } })).checked).toBe(true)

    ;(checkImageContent as jest.Mock).mockResolvedValue({ checked: true, result: { action: "hide" } })
    await runAfter()
    expect(await blurOf(p.id)).toBeNull()
  })

  it("does not let a late verdict on an old blur clear the newer one", async () => {
    const p = await withBlur()
    expect((await p.put({ blur_photo: upload(p.id, "a2-blur.jpg") })).status).toBe(200)
    ;(checkImageContent as jest.Mock).mockResolvedValue({ checked: true, result: { action: "hide" } })
    await moderateBlurPhoto(sealedOf(p.id, "a-blur.jpg"), p.id)
    expect(await blurOf(p.id)).toBe(sealedOf(p.id, "a2-blur.jpg"))
  })
})

/*
 * The blur this write replaced or cleared leaves storage (SCRUM-520).
 *
 * The column moved on and the object stayed: one test profile on staging held
 * seven stale blurs, each still served to anyone holding its URL -- and every
 * viewer of the card had been handed that URL.
 */
describe("a replaced or cleared blur leaves storage", () => {
  const sealedKey = (id: string, name: string) => `profile/${id}/sealed-1790641297767-cfg6ta-${name}`

  /** `withBlur`, with moderation having judged the blur and let it stand. */
  async function withJudgedBlur() {
    const p = await withBlur()
    ;(checkImageContent as jest.Mock).mockResolvedValue({ checked: true, result: { action: "allow" } })
    await runAfter()
    jest.clearAllMocks()
    return p
  }

  it("deletes the old blur when a new one replaces it", async () => {
    const p = await withJudgedBlur()
    expect((await p.put({ blur_photo: upload(p.id, "a-blur-edge.jpg") })).status).toBe(200)
    expect(await blurOf(p.id)).toBe(sealedOf(p.id, "a-blur-edge.jpg"))
    // After the response, as moderation is.
    expect(deleteFile).not.toHaveBeenCalled()
    await runAfter()
    expect(deleteFile).toHaveBeenCalledTimes(1)
    expect(deleteFile).toHaveBeenCalledWith(sealedKey(p.id, "a-blur.jpg"))
  })

  it("deletes it when the blur is cleared: an explicit null, a new primary without one, or no photos left", async () => {
    for (const body of [
      { blur_photo: null },
      (id: string) => ({ photos: [upload(id, "b.jpg"), sealedOf(id, "a.jpg")] }),
      { photos: [] },
    ]) {
      const p = await withJudgedBlur()
      expect((await p.put(typeof body === "function" ? body(p.id) : body)).status).toBe(200)
      expect(await blurOf(p.id)).toBeNull()
      await runAfter()
      expect(deleteFile).toHaveBeenCalledTimes(1)
      expect(deleteFile).toHaveBeenCalledWith(sealedKey(p.id, "a-blur.jpg"))
      jest.clearAllMocks()
    }
  })

  it("deletes one replaced before its verdict once the verdict passes", async () => {
    const p = await withBlur()
    jest.clearAllMocks()
    expect((await p.put({ blur_photo: upload(p.id, "a-blur-edge.jpg") })).status).toBe(200)
    await runAfter()
    expect(deleteFile).not.toHaveBeenCalled()
    // The old blur's own moderation, landing late -- clean, which is no result at all
    // (`openai-moderation` returns null for a clean image; there is no "allow").
    ;(checkImageContent as jest.Mock).mockResolvedValue({ checked: true, result: null })
    await moderateBlurPhoto(sealedOf(p.id, "a-blur.jpg"), p.id)
    expect(deleteFile).toHaveBeenCalledTimes(1)
    expect(deleteFile).toHaveBeenCalledWith(sealedKey(p.id, "a-blur.jpg"))
    // And the current blur passing deletes nothing.
    await moderateBlurPhoto(sealedOf(p.id, "a-blur-edge.jpg"), p.id)
    expect(deleteFile).toHaveBeenCalledTimes(1)
  })

  it("keeps one replaced before its verdict when the verdict is a borderline flag", async () => {
    const p = await withBlur()
    jest.clearAllMocks()
    expect((await p.put({ blur_photo: upload(p.id, "a-blur-edge.jpg") })).status).toBe(200)
    ;(checkImageContent as jest.Mock).mockResolvedValue({ checked: true, result: { action: "flag" } })
    await moderateBlurPhoto(sealedOf(p.id, "a-blur.jpg"), p.id)
    expect(deleteFile).not.toHaveBeenCalled()
  })

  it("never deletes a blur that is not the caller's own object", async () => {
    for (const foreign of ["https://example.com/anyone-blur.jpg", sealedOf("someone-else", "x-blur.jpg")]) {
      const p = await withJudgedBlur()
      // A legacy row, written before blurs were sealed; judged, so only ownership stands in the way.
      await db.profiles.update({ where: { id: p.id }, data: { blur_photo: foreign } })
      await db.photo_checks.create({ data: { url: foreign, user_id: p.id, checked: true } })
      expect((await p.put({ blur_photo: null })).status).toBe(200)
      await runAfter()
      expect(deleteFile).not.toHaveBeenCalled()
      await db.photo_checks.delete({ where: { url: foreign } })
    }
  })

  it("keeps an old blur moderation has not judged yet, so a pull can still hold it", async () => {
    const p = await withBlur()
    jest.clearAllMocks()
    expect((await p.put({ blur_photo: null })).status).toBe(200)
    await runAfter()
    expect(deleteFile).not.toHaveBeenCalled()
  })

  it("deletes nothing when the blur stays", async () => {
    const p = await withJudgedBlur()
    expect((await p.put({ bio: "only the bio" })).status).toBe(200)
    expect((await p.put({ blur_photo: sealedOf(p.id, "a-blur.jpg") })).status).toBe(200)
    expect((await p.put({ photos: [sealedOf(p.id, "a.jpg"), upload(p.id, "b.jpg")] })).status).toBe(200)
    await runAfter()
    expect(deleteFile).not.toHaveBeenCalled()
  })

  it("never fails the save, or the work after it, because storage would not delete", async () => {
    const p = await withJudgedBlur()
    ;(deleteFile as jest.Mock).mockRejectedValueOnce(new Error("tigris down"))
    expect((await p.put({ blur_photo: null })).status).toBe(200)
    await expect(runAfter()).resolves.toBeDefined()
    expect(deleteFile).toHaveBeenCalled()
    expect(await blurOf(p.id)).toBeNull()
  })
})
