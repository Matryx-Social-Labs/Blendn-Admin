import { NextRequest } from "next/server"

/*
 * A profile photo moderation pulls stays pulled (SCRUM-479).
 *
 * The pull took the URL off the row and left the object in the public bucket,
 * so every viewer already served it could still fetch it. It recorded the same
 * `checked = true` as a pass, so a save that re-sent the list it last saw put
 * the photo back, and account deletion could not keep it for the 180 days
 * removed content is kept (docs/RETENTION.md, r.3(1)(g)). Now the verdict is
 * recorded, the object moves to the private bucket, a re-sent URL is dropped,
 * and deletion keeps it until the purge.
 */
process.env.MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("next/server", () => ({ ...jest.requireActual("next/server"), after: jest.fn() }))
jest.mock("@/lib/moderation/openai-moderation", () => ({ checkImageContent: jest.fn() }))
jest.mock("@/lib/tigris", () => ({
  ...jest.requireActual("@/lib/tigris"),
  withdrawFromPublic: jest.fn().mockResolvedValue(undefined),
  deletePrefix: jest.fn().mockResolvedValue(0),
  isConfigured: () => true,
  sealUpload: jest.fn(async (key: string, _folder: string, userId: string) => {
    const name = key.split("/").pop()!
    return {
      key: `profile/${userId}/sealed-${name}`,
      url: `https://${process.env.TIGRIS_BUCKET || "blendn-media"}.fly.storage.tigris.dev/profile/${userId}/sealed-${name}`,
      bytes: 120_000,
      contentType: "image/jpeg",
    }
  }),
}))

import { checkImageContent } from "@/lib/moderation/openai-moderation"
import { signAccessToken } from "@/lib/mobile-auth"
import { moderateBlurPhoto, moderateProfilePhoto } from "@/lib/photos"
import { purgeDeletedAccountRecords } from "@/lib/deleted-account-records"
import { deletePrefix, withdrawFromPublic } from "@/lib/tigris"
import { db, closeDb, makeUser, onboard } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const profileRoute = require("@/app/api/mobile/profiles/[userId]/route") as
  typeof import("@/app/api/mobile/profiles/[userId]/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const accountRoute = require("@/app/api/mobile/account/route") as typeof import("@/app/api/mobile/account/route")

const users: string[] = []
afterAll(async () => {
  if (users.length) {
    await db.deleted_account_records.deleteMany({ where: { user_id: { in: users } } })
    await db.photo_checks.deleteMany({ where: { user_id: { in: users } } })
    await db.profiles.deleteMany({ where: { id: { in: users } } })
    await db.user.deleteMany({ where: { id: { in: users } } })
  }
  await closeDb()
})

beforeEach(() => jest.clearAllMocks())

const bucketHost = `https://${process.env.TIGRIS_BUCKET || "blendn-media"}.fly.storage.tigris.dev`
const HIDE = { checked: true, result: { action: "hide" } }

/** Someone with three sealed photos and a blur of the first, all checked and passed. */
async function person() {
  const id = await makeUser("pulled")
  users.push(id)
  await onboard(id)
  const key = (name: string) => `profile/${id}/sealed-1790641297767-cfg6ta-${name}`
  const url = (name: string) => `${bucketHost}/${key(name)}`
  const [p, q, r, blur] = [url("p.jpg"), url("q.jpg"), url("r.jpg"), url("blur.jpg")]
  await db.profiles.update({ where: { id }, data: { photos: [p, q, r], blur_photo: blur } })
  await db.user.update({ where: { id }, data: { image: p } })
  await db.photo_checks.createMany({ data: [p, q, r, blur].map((u) => ({ url: u, user_id: id, checked: true })) })
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
  const deleteAccount = () =>
    accountRoute.DELETE(
      new NextRequest("http://localhost/api/mobile/account", {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      })
    )
  return { id, key, p, q, r, blur, put, deleteAccount }
}

const rowOf = (id: string) =>
  db.profiles.findUniqueOrThrow({ where: { id }, select: { photos: true, blur_photo: true } })
const imageOf = async (id: string) => (await db.user.findUniqueOrThrow({ where: { id }, select: { image: true } })).image
const hiddenOf = async (id: string) =>
  (await db.photo_checks.findMany({ where: { user_id: id, hidden: true }, select: { url: true } })).map((r) => r.url).sort()

describe("a pulled primary photo", () => {
  it("leaves the row with its blur, is recorded as pulled, and leaves the public bucket", async () => {
    const { id, key, p, q, r, blur } = await person()
    ;(checkImageContent as jest.Mock).mockResolvedValue(HIDE)

    await moderateProfilePhoto(p, id)

    expect(await rowOf(id)).toEqual({ photos: [q, r], blur_photo: null })
    expect(await imageOf(id)).toBe(q)
    expect(await hiddenOf(id)).toEqual([blur, p].sort())
    expect((withdrawFromPublic as jest.Mock).mock.calls.map(([k]) => k).sort()).toEqual([key("blur.jpg"), key("p.jpg")].sort())
  })

  it("stays off the profile when a save re-sends the list it last saw", async () => {
    const { id, p, q, r, blur, put } = await person()
    ;(checkImageContent as jest.Mock).mockResolvedValue(HIDE)
    await moderateProfilePhoto(p, id)

    const res = await put({ photos: [p, q, r], blur_photo: blur, bio: "still me" })

    expect(res.status).toBe(200)
    expect(await rowOf(id)).toEqual({ photos: [q, r], blur_photo: null })
    expect(await imageOf(id)).toBe(q)
  })
})

describe("the same pulled photo under another spelling", () => {
  it("is dropped all the same: matched on the object, not the string", async () => {
    const { id, p, q, r, put } = await person()
    ;(checkImageContent as jest.Mock).mockResolvedValue(HIDE)
    await moderateProfilePhoto(p, id)

    expect((await put({ photos: [`${p}?v=2`, q, r] })).status).toBe(200)
    expect((await rowOf(id)).photos).toEqual([q, r])
  })

  it("tells a stranger nothing: someone else's pulled URL is refused as not theirs, like any other", async () => {
    const owner = await person()
    ;(checkImageContent as jest.Mock).mockResolvedValue(HIDE)
    await moderateProfilePhoto(owner.p, owner.id)
    const stranger = await person()

    const res = await stranger.put({ photos: [owner.p] })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { errorCode?: string }).errorCode).toBe("not_ours")
  })
})

describe("a pulled photo that is not the primary", () => {
  it("keeps the primary's blur and withdraws only itself", async () => {
    const { id, key, p, q, r, blur } = await person()
    ;(checkImageContent as jest.Mock).mockResolvedValue(HIDE)

    await moderateProfilePhoto(q, id)

    expect(await rowOf(id)).toEqual({ photos: [p, r], blur_photo: blur })
    expect(await imageOf(id)).toBe(p)
    expect(await hiddenOf(id)).toEqual([q])
    expect((withdrawFromPublic as jest.Mock).mock.calls).toEqual([[key("q.jpg")]])
  })
})

describe("a pulled blur", () => {
  it("is cleared, recorded, withdrawn, and not written back by a save", async () => {
    const { id, key, p, q, r, blur, put } = await person()
    ;(checkImageContent as jest.Mock).mockResolvedValue(HIDE)

    await moderateBlurPhoto(blur, id)
    expect(await rowOf(id)).toEqual({ photos: [p, q, r], blur_photo: null })
    expect(await hiddenOf(id)).toEqual([blur])
    expect((withdrawFromPublic as jest.Mock).mock.calls).toEqual([[key("blur.jpg")]])

    expect((await put({ photos: [p, q, r], blur_photo: blur })).status).toBe(200)
    expect((await rowOf(id)).blur_photo).toBeNull()
  })
})

describe("deleting the account", () => {
  it("keeps a pulled photo and its verdict until the purge, and nothing else", async () => {
    const { id, key, p, deleteAccount } = await person()
    ;(checkImageContent as jest.Mock).mockResolvedValue(HIDE)
    await moderateProfilePhoto(p, id)

    expect((await deleteAccount()).status).toBe(200)

    const profileSweep = (deletePrefix as jest.Mock).mock.calls.find(([prefix]) => prefix === `profile/${id}/`)
    expect([...(profileSweep?.[1] ?? [])].sort()).toEqual([key("blur.jpg"), key("p.jpg")].sort())
    expect((await db.photo_checks.findMany({ where: { user_id: id }, select: { hidden: true } })).every((r) => r.hidden)).toBe(true)
    expect(await db.photo_checks.count({ where: { user_id: id } })).toBe(2)

    await db.deleted_account_records.updateMany({ where: { user_id: id }, data: { purge_after: new Date(Date.now() - 1000) } })
    ;(deletePrefix as jest.Mock).mockClear()
    await purgeDeletedAccountRecords()

    expect((deletePrefix as jest.Mock).mock.calls).toContainEqual([`profile/${id}/`])
    expect(await db.photo_checks.count({ where: { user_id: id } })).toBe(0)
  })
})
