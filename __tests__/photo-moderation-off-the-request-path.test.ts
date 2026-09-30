/**
 * The vendor check is not on the profile PUT's request path.
 *
 * Testers said uploading a profile photo is slow. The perf pass put the wall
 * clock in one place: `checkProfilePhoto` called OpenAI's image moderation
 * inside the PUT that makes the photo appear, with no deadline, so the
 * spinner waited on a vendor fetching and scoring the image. The read side
 * never consulted the verdict (every vendor failure already degraded to
 * `checked: false`), so the split below costs nothing it did not already
 * cost — it just stops the person paying for it.
 */
jest.mock("@/lib/tigris", () => ({
  ownedPhotoKey: jest.fn(),
  sealUpload: jest.fn(),
  withdrawFromPublic: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("@/lib/moderation/openai-moderation", () => ({
  checkImageContent: jest.fn(),
}))
jest.mock("@/lib/photo-checks", () => ({
  recordPhotoCheck: jest.fn().mockResolvedValue(undefined),
  recordPhotoPulled: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }))
jest.mock("@/lib/db", () => ({
  db: {
    profiles: { findUnique: jest.fn(), update: jest.fn((a) => a) },
    user: { update: jest.fn((a) => a) },
    $queryRaw: jest.fn(),
  },
}))

import { checkImageContent } from "@/lib/moderation/openai-moderation"
import { recordPhotoCheck, recordPhotoPulled } from "@/lib/photo-checks"
import { ownedPhotoKey, sealUpload, withdrawFromPublic } from "@/lib/tigris"
import { db } from "@/lib/db"
import { checkProfilePhoto, MIN_PHOTO_BYTES, moderateProfilePhoto } from "@/lib/photos"
import { logger } from "@/lib/logger"

const own = ownedPhotoKey as jest.Mock
const seal = sealUpload as jest.Mock
const vendor = checkImageContent as jest.Mock
const record = recordPhotoCheck as jest.Mock
const pulled = recordPhotoPulled as jest.Mock
const withdraw = withdrawFromPublic as jest.Mock
const pull = db.$queryRaw as unknown as jest.Mock
const BLUR = "https://blendn-media.fly.storage.tigris.dev/profile/u1/3-c-sealed"
const URL = "https://blendn-media.fly.storage.tigris.dev/profile/u1/1-a-photo.jpg"
const SEALED = "https://blendn-media.fly.storage.tigris.dev/profile/u1/2-b-sealed"

beforeEach(() => {
  jest.clearAllMocks()
  own.mockReturnValue("profile/u1/1-a-photo.jpg")
})

describe("checkProfilePhoto (request path)", () => {
  it("never calls the vendor, and answers with the sealed copy (SCRUM-425)", async () => {
    seal.mockResolvedValue({ key: "profile/u1/2-b-sealed", url: SEALED, bytes: 200_000, contentType: "image/jpeg" })
    await expect(checkProfilePhoto(URL, "u1")).resolves.toEqual({ ok: true, checked: false, url: SEALED })
    // The blank-photo floor is applied to the copy, which is what is stored.
    // No ceiling of its own: a photo is held to the folder's (a blur is not, SCRUM-476).
    expect(seal).toHaveBeenCalledWith("profile/u1/1-a-photo.jpg", "profile", "u1", MIN_PHOTO_BYTES, undefined)
    expect(vendor).not.toHaveBeenCalled()
  })

  it("still refuses what the cheap gates catch: missing, blank, huge, not a photo, not ours", async () => {
    for (const [refused, code] of [
      ["missing", "too_small"],
      ["too_small", "too_small"],
      ["too_large", "too_large"],
      ["wrong_type", "wrong_type"],
    ]) {
      seal.mockResolvedValueOnce({ refused })
      expect((await checkProfilePhoto(URL, "u1")) as { code?: string }).toMatchObject({ ok: false, code })
    }
    own.mockReturnValueOnce(null)
    expect((await checkProfilePhoto("https://evil/x.jpg", "u1")) as { code?: string }).toMatchObject({ ok: false, code: "not_ours" })
    expect(seal).toHaveBeenCalledTimes(4)
    expect(vendor).not.toHaveBeenCalled()
  })
})

describe("moderateProfilePhoto (after the response)", () => {
  it("a hide verdict pulls the photo, re-mirrors the primary and withdraws it with its blur (SCRUM-479)", async () => {
    vendor.mockResolvedValue({ checked: true, result: { action: "hide" } })
    // The primary went, so the blur made from it goes too (SCRUM-476).
    pull.mockResolvedValue([{ photos: ["https://cdn/b.jpg"], cleared_blur: BLUR }])

    await moderateProfilePhoto(URL, "u1")

    // One statement against this person's row, keyed on the pulled URL.
    const [, ...values] = pull.mock.calls[0]
    expect(values).toEqual([URL, URL, "u1", URL])
    expect(db.user.update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { image: "https://cdn/b.jpg" } })
    expect(pulled.mock.calls).toEqual([[URL, "u1"], [BLUR, "u1"]])
    expect(withdraw).toHaveBeenCalledTimes(2)
    expect(record).not.toHaveBeenCalled()
  })

  it("a hide verdict on a non-primary photo leaves User.image on the primary", async () => {
    vendor.mockResolvedValue({ checked: true, result: { action: "hide" } })
    pull.mockResolvedValue([{ photos: ["https://cdn/a.jpg", "https://cdn/c.jpg"], cleared_blur: null }])

    await moderateProfilePhoto(URL, "u1")

    expect(db.user.update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { image: "https://cdn/a.jpg" } })
    expect(pulled.mock.calls).toEqual([[URL, "u1"]])
    expect(withdraw).toHaveBeenCalledTimes(1)
  })

  it("a failure inside the after() task is logged with the user and url, not thrown into console.error", async () => {
    // Nothing above this function: Next reports a rejected after() task with
    // a bare console.error, which is not where this app's errors go.
    vendor.mockResolvedValue({ checked: true, result: { action: "hide" } })
    pull.mockRejectedValueOnce(new Error("connection closed"))

    await expect(moderateProfilePhoto(URL, "u1")).resolves.toBeUndefined()
    expect(logger.error).toHaveBeenCalledWith(
      "Profile photo moderation failed; photo left in place",
      expect.objectContaining({ userId: "u1", url: URL, error: "connection closed" })
    )
    // The verdict went first, so a save that re-sends the URL still drops it.
    expect(pulled).toHaveBeenCalledWith(URL, "u1")
    expect(withdraw).not.toHaveBeenCalled()
  })

  it("a clean verdict upgrades the record and touches nothing else", async () => {
    vendor.mockResolvedValue({ checked: true, result: { action: "allow" } })
    await moderateProfilePhoto(URL, "u1")
    expect(db.profiles.update).not.toHaveBeenCalled()
    expect(record).toHaveBeenCalledWith(URL, "u1", true)
  })

  it("a vendor timeout leaves the photo up and the record unchecked, which the moderation screen counts", async () => {
    vendor.mockResolvedValue({ checked: false, reason: "error" })
    await moderateProfilePhoto(URL, "u1")
    expect(db.profiles.update).not.toHaveBeenCalled()
    expect(record).toHaveBeenCalledWith(URL, "u1", false)
  })
})

describe("the vendor calls have a deadline", () => {
  it("both OpenAI fetches carry AbortSignal.timeout", async () => {
    const { readFileSync } = await import("fs")
    const src = readFileSync(require.resolve("@/lib/moderation/openai-moderation"), "utf8")
    expect(src.match(/signal: AbortSignal\.timeout\(MODERATION_TIMEOUT_MS\)/g)?.length).toBe(2)
    // The seal's copy and HEAD are on the profile PUT's path too.
    const tigris = readFileSync(require.resolve("@/lib/tigris"), "utf8")
    expect(tigris).toMatch(/const timeout = \(\) => \(\{ abortSignal: AbortSignal\.timeout\(SEAL_TIMEOUT_MS\) \}\)/)
    // Used by the HEADs and the copy.
    expect(tigris.match(/timeout\(\)/g)?.length).toBe(2)
  })
})

describe("the profile PUT hands the vendor check to after()", () => {
  it("schedules moderateProfilePhoto after the response and does not import the vendor itself", async () => {
    const { readFileSync } = await import("fs")
    const { join } = await import("path")
    const src = readFileSync(join(__dirname, "..", "app/api/mobile/profiles/[userId]/route.ts"), "utf8")
    expect(src).toMatch(/import \{ NextRequest, after \} from "next\/server"/)
    // The sealed copies, the URLs the profile stores (SCRUM-425).
    expect(src).toMatch(/after\(\(\) => Promise\.all\(sealed\.map\(\(u: string\) => moderateProfilePhoto\(u, userId\)\)\)\)/)
    // The vendor is reached only through lib/photos, after the response.
    expect(src).not.toMatch(/import .*checkImageContent/)
  })
})

describe("a real timeout through the vendor module", () => {
  // The module above is mocked; this loads the real one in isolation with
  // fetch rejecting the way AbortSignal.timeout rejects it.
  it("reports checked:false with reason timeout, never a clean verdict", async () => {
    await jest.isolateModulesAsync(async () => {
      jest.doMock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }))
      const real = jest.requireActual("@/lib/moderation/openai-moderation") as typeof import("@/lib/moderation/openai-moderation")
      process.env.OPENAI_API_KEY = "sk-test"
      const timeout = new Error("The operation was aborted due to timeout")
      timeout.name = "TimeoutError"
      const fetchSpy = jest.spyOn(globalThis, "fetch").mockRejectedValue(timeout)
      try {
        await expect(real.checkImageContent("https://cdn/x.jpg")).resolves.toEqual({ checked: false, reason: "timeout" })
        await expect(real.checkTextContent("hello")).resolves.toEqual({ checked: false, reason: "timeout" })
        // And any other failure is still an error, not a timeout.
        fetchSpy.mockRejectedValue(new Error("ECONNRESET"))
        await expect(real.checkTextContent("hello")).resolves.toEqual({ checked: false, reason: "error" })
      } finally {
        fetchSpy.mockRestore()
        delete process.env.OPENAI_API_KEY
      }
    })
  })
})
