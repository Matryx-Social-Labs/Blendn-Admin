/**
 * A child-safety image verdict pulls the photo, pages staff once, and leaves an
 * audit row (SCRUM-1163, launch gate 9), on every path that acts on an image
 * verdict: the profile photo, its blurred copy, and a Lobby post's photo.
 *
 * The page leaves the platform, so it carries the storage key and the user id
 * and nothing else: no URL, no image, no name. And the page and the audit row
 * come after the pull and can never undo it: a channel that is down, or none
 * configured, or an audit write that throws, is logged as an error and the
 * photo stays down.
 */
jest.mock("@/lib/tigris", () => ({
  ownedPhotoKey: jest.fn(),
  sealedChatKey: jest.fn(),
  readableUrl: jest.fn(async (u: string) => `${u}?signed`),
  withdrawFromPublic: jest.fn().mockResolvedValue(undefined),
  deleteFile: jest.fn().mockResolvedValue(undefined),
  sealUpload: jest.fn(),
}))
jest.mock("@/lib/moderation/openai-moderation", () => ({ checkImageContent: jest.fn(), checkTextContent: jest.fn() }))
jest.mock("@/lib/photo-checks", () => ({
  recordPhotoCheck: jest.fn().mockResolvedValue(undefined),
  recordPhotoPulled: jest.fn().mockResolvedValue(undefined),
  notePulledProfilePhoto: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("@/lib/staff-alert", () => ({ notifyStaff: jest.fn() }))
jest.mock("@/lib/audit-log", () => ({ auditLog: jest.fn() }))
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }))
jest.mock("@/lib/db", () => ({
  db: {
    profiles: { findUnique: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    user: { update: jest.fn() },
    board_posts: { findUnique: jest.fn(), updateMany: jest.fn() },
    photo_checks: { findUnique: jest.fn() },
    $queryRaw: jest.fn(),
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(jest.requireMock("@/lib/db").db)),
  },
}))

import { checkImageContent, type ModerationCheck } from "@/lib/moderation/openai-moderation"
import { recordPhotoPulled } from "@/lib/photo-checks"
import { ownedPhotoKey, sealedChatKey, withdrawFromPublic } from "@/lib/tigris"
import { notifyStaff } from "@/lib/staff-alert"
import { auditLog } from "@/lib/audit-log"
import { logger } from "@/lib/logger"
import { db } from "@/lib/db"
import { moderateBlurPhoto, moderateProfilePhoto } from "@/lib/photos"
import { moderateLobbyPhoto } from "@/lib/lobby-photo"

const USER = "4b8f8a52-7a0e-4c39-9d0b-0a3c2f1e5d11"
const PROFILE_KEY = `profile/${USER}/1764100000000-ab12cd-sealed`
const PROFILE_URL = `https://blendn-media.fly.storage.tigris.dev/${PROFILE_KEY}`
const BLUR_KEY = `profile/${USER}/1764100000001-ef34gh-sealed`
const BLUR_URL = `https://blendn-media.fly.storage.tigris.dev/${BLUR_KEY}`
const POST = "9c1d2e3f-0000-4000-8000-000000000001"
const LOBBY_KEY = "chat/sealed/0f0e0d0c-0b0a-4909-8807-060504030201"
const LOBBY_URL = `https://blendn-media-private.fly.storage.tigris.dev/${LOBBY_KEY}`

const CHILD_SAFETY: ModerationCheck = {
  checked: true,
  result: { action: "hide", source: "openai_image", categories: { "sexual/minors": 0.25 }, confidence: 0.25 },
}
const ORDINARY_HIDE: ModerationCheck = {
  checked: true,
  result: { action: "hide", source: "openai_image", categories: { violence: 0.9 }, confidence: 0.9 },
}

const vendor = checkImageContent as jest.Mock
const page = notifyStaff as jest.Mock
const audit = auditLog as jest.Mock
const pulled = recordPhotoPulled as jest.Mock
const withdraw = withdrawFromPublic as jest.Mock
const lobbyCheck = jest.fn()

/** One image path: how to run it with a verdict, the key it names, and what "pulled" means on it. */
interface ImagePath {
  name: string
  key: string
  run: (check: ModerationCheck) => Promise<unknown>
  expectPulled: () => void
}

const PATHS: ImagePath[] = [
  {
    name: "profile photo",
    key: PROFILE_KEY,
    run: async (check) => {
      vendor.mockResolvedValue(check)
      await moderateProfilePhoto(PROFILE_URL, USER)
    },
    expectPulled: () => {
      expect(pulled).toHaveBeenCalledWith(PROFILE_URL, USER)
      expect(withdraw).toHaveBeenCalledWith(PROFILE_KEY)
    },
  },
  {
    name: "blur photo",
    key: BLUR_KEY,
    run: async (check) => {
      vendor.mockResolvedValue(check)
      await moderateBlurPhoto(BLUR_URL, USER)
    },
    expectPulled: () => {
      expect(pulled).toHaveBeenCalledWith(BLUR_URL, USER)
      expect(db.profiles.updateMany).toHaveBeenCalledWith({ where: { id: USER, blur_photo: BLUR_URL }, data: { blur_photo: null } })
      expect(withdraw).toHaveBeenCalledWith(BLUR_KEY)
    },
  },
  {
    name: "Lobby photo",
    key: LOBBY_KEY,
    run: async (check) => {
      lobbyCheck.mockResolvedValue(check)
      await moderateLobbyPhoto(POST, lobbyCheck)
    },
    expectPulled: () => {
      expect(db.board_posts.updateMany).toHaveBeenCalledWith({
        where: { id: POST, photo_status: "pending" },
        data: { photo_status: "rejected", photo_checked_at: expect.any(Date) },
      })
    },
  },
]

beforeEach(() => {
  jest.clearAllMocks()
  ;(ownedPhotoKey as jest.Mock).mockImplementation((url: string) => (url === PROFILE_URL ? PROFILE_KEY : url === BLUR_URL ? BLUR_KEY : null))
  ;(sealedChatKey as jest.Mock).mockImplementation((url: string) => (url === LOBBY_URL ? LOBBY_KEY : null))
  ;(db.$queryRaw as unknown as jest.Mock).mockResolvedValue([{ photos: [], cleared_blur: null, was_main: true }])
  ;(db.board_posts.findUnique as jest.Mock).mockResolvedValue({ author_id: USER, photo_url: LOBBY_URL, photo_status: "pending" })
  ;(db.board_posts.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
  page.mockResolvedValue("sent")
})

describe.each(PATHS)("a child-safety verdict on the $name", (path) => {
  it("pulls it, pages staff once with the key and the user id only, and writes the audit row", async () => {
    await path.run(CHILD_SAFETY)

    path.expectPulled()
    expect(page).toHaveBeenCalledTimes(1)
    expect(page).toHaveBeenCalledWith(`Child-safety image hold (sexual/minors).\nUser: ${USER}\nObject key: ${path.key}`)
    expect(audit).toHaveBeenCalledTimes(1)
    // No actor: the platform did this, as for every automated row (lib/audit-log.ts `actsFor`).
    expect(audit).toHaveBeenCalledWith({
      action: "moderation.child_safety_hold",
      resource: "user",
      resourceId: USER,
      details: { objectKey: path.key, category: "sexual/minors" },
    })
  })

  it("pages only after the photo is pulled", async () => {
    await path.run(CHILD_SAFETY)
    const pullCall = path.name === "Lobby photo" ? (db.board_posts.updateMany as jest.Mock) : withdraw
    expect(pullCall.mock.invocationCallOrder[0]).toBeLessThan(page.mock.invocationCallOrder[0])
  })

  it("an ordinary hide pulls it and pages nobody", async () => {
    await path.run(ORDINARY_HIDE)
    path.expectPulled()
    expect(page).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })

  it.each(["failed", "unconfigured"])("a page that comes back %s leaves the photo pulled and logs an error", async (result) => {
    page.mockResolvedValue(result)
    await path.run(CHILD_SAFETY)

    path.expectPulled()
    expect(audit).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith(
      "Child-safety image hold: staff were not paged",
      { userId: USER, objectKey: path.key, result }
    )
  })

  it("an audit write that throws leaves the photo pulled, still pages, and logs an error", async () => {
    audit.mockImplementation(() => {
      throw new Error("audit down")
    })
    await path.run(CHILD_SAFETY)

    path.expectPulled()
    expect(page).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith(
      "Child-safety image hold: audit row not written",
      { userId: USER, objectKey: path.key, error: "audit down" }
    )
  })
})

describe("the page is never lost to a pull that fails", () => {
  it("a profile pull that throws still pages, and the failure is logged", async () => {
    pulled.mockRejectedValueOnce(new Error("deadlock detected"))
    vendor.mockResolvedValue(CHILD_SAFETY)

    await moderateProfilePhoto(PROFILE_URL, USER)

    expect(page).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith("Profile photo moderation failed; photo left in place", expect.objectContaining({ userId: USER }))
  })

  it("a Lobby photo another pass already decided pages nobody: that pass did", async () => {
    ;(db.board_posts.updateMany as jest.Mock).mockResolvedValue({ count: 0 })
    lobbyCheck.mockResolvedValue(CHILD_SAFETY)

    await moderateLobbyPhoto(POST, lobbyCheck)

    expect(page).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })
})
