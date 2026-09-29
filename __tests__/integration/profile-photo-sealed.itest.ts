import { NextRequest } from "next/server"

/*
 * A profile stores the sealed copy of a photo, never the URL it was uploaded
 * to (SCRUM-425).
 *
 * Found on staging: a photo attached through this PUT, checked and moderated,
 * was replaced with other bytes by PUTting to the same upload URL again, and
 * the profile went on pointing at it. The copy `sealUpload` makes has a key
 * nobody holds an upload URL for. The copy itself is tested in
 * upload-seal.test.ts; here, that the profile stores it and moderates it.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("next/server", () => ({ ...jest.requireActual("next/server"), after: jest.fn() }))
jest.mock("@/lib/tigris", () => ({
  ...jest.requireActual("@/lib/tigris"),
  sealUpload: jest.fn(async (key: string, _folder: string, userId: string) =>
    key.endsWith("-missing.jpg")
      ? { refused: "missing" }
      : {
          key: `profile/${userId}/sealed-${key.split("/").pop()}`,
          url: `https://${process.env.TIGRIS_BUCKET || "blendn-media"}.fly.storage.tigris.dev/profile/${userId}/sealed-${key.split("/").pop()}`,
          bytes: 120_000,
          contentType: "image/jpeg",
        }
  ),
}))

import { after } from "next/server"
import { signAccessToken } from "@/lib/mobile-auth"
import { sealUpload } from "@/lib/tigris"
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

async function person({ withProfile = true } = {}) {
  const id = await makeUser("photo")
  users.push(id)
  if (withProfile) await onboard(id)
  const { email } = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  const put = (body: object) =>
    profileRoute.PUT(
      new NextRequest(`http://localhost/api/mobile/profiles/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: `Bearer ${signAccessToken(id, email)}` },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ userId: id }) }
    )
  return { id, put }
}

beforeEach(() => jest.clearAllMocks())

describe("a new profile photo", () => {
  it("is stored as its sealed copy, mirrored to User.image, and recorded and moderated as that copy", async () => {
    const p = await person()
    const res = await p.put({ photos: [upload(p.id, "a.jpg")] })
    expect(res.status).toBe(200)

    const profile = await db.profiles.findUniqueOrThrow({ where: { id: p.id }, select: { photos: true } })
    expect(profile.photos).toEqual([sealedOf(p.id, "a.jpg")])
    const user = await db.user.findUniqueOrThrow({ where: { id: p.id }, select: { image: true } })
    expect(user.image).toBe(sealedOf(p.id, "a.jpg"))
    const checks = await db.photo_checks.findMany({ where: { user_id: p.id }, select: { url: true } })
    expect(checks.map((c) => c.url)).toEqual([sealedOf(p.id, "a.jpg")])
    expect(after).toHaveBeenCalledTimes(1)
  })

  it("is stored as its sealed copy when the PUT creates the profile row", async () => {
    const p = await person({ withProfile: false })
    expect((await p.put({ photos: [upload(p.id, "a.jpg")] })).status).toBe(200)
    const profile = await db.profiles.findUniqueOrThrow({ where: { id: p.id }, select: { photos: true } })
    expect(profile.photos).toEqual([sealedOf(p.id, "a.jpg")])
  })

  it("is refused when it cannot be sealed, and the profile keeps what it had", async () => {
    const p = await person()
    expect((await p.put({ photos: [upload(p.id, "a.jpg")] })).status).toBe(200)
    const res = await p.put({ photos: [sealedOf(p.id, "a.jpg"), upload(p.id, "b-missing.jpg")] })
    expect(res.status).toBe(400)
    const profile = await db.profiles.findUniqueOrThrow({ where: { id: p.id }, select: { photos: true } })
    expect(profile.photos).toEqual([sealedOf(p.id, "a.jpg")])
  })

  it("listed twice in one save is sealed once", async () => {
    const p = await person()
    expect((await p.put({ photos: [upload(p.id, "a.jpg"), upload(p.id, "a.jpg")] })).status).toBe(200)
    expect(sealUpload).toHaveBeenCalledTimes(1)
  })

  it("already on the profile is not copied again: a reorder keeps the stored URLs", async () => {
    const p = await person()
    expect((await p.put({ photos: [upload(p.id, "a.jpg"), upload(p.id, "b.jpg")] })).status).toBe(200)
    ;(sealUpload as jest.Mock).mockClear()
    const reordered = [sealedOf(p.id, "b.jpg"), sealedOf(p.id, "a.jpg")]
    expect((await p.put({ photos: reordered })).status).toBe(200)
    expect(sealUpload).not.toHaveBeenCalled()
    const profile = await db.profiles.findUniqueOrThrow({ where: { id: p.id }, select: { photos: true } })
    expect(profile.photos).toEqual(reordered)
  })
})
