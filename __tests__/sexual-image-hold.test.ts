/**
 * A sexual image that moderation pulls goes to a person (SCRUM-1163, launch gate 9).
 *
 * OpenAI's omni-moderation scores `sexual/minors` on text only: an image alone
 * scores 0 on it (developers.openai.com/api/docs/guides/moderation, read
 * 2026-11-26). Nothing here can tell a minor or a non-consensual image from
 * any other sexual image, so every IMAGE hide naming `sexual` (or
 * `sexual/minors`, should the vendor ever score it on images) pages staff once
 * and leaves a `moderation.sexual_image_hold` audit row, on every path that
 * acts on an image verdict: the profile photo, its blurred copy, a Lobby photo.
 *
 * The page leaves the platform: a fixed sentence, the storage key, the user id
 * and the dashboard link, nothing else. It and the audit row come after the
 * pull and can never undo it.
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
jest.mock("@/lib/audit-log", () => ({ auditInTx: jest.fn().mockResolvedValue(undefined) }))
jest.mock("@/lib/email", () => ({ dashboardUrl: () => "https://dash.test" }))
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }))
jest.mock("@/lib/db", () => ({
  db: {
    profiles: { findUnique: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    user: { update: jest.fn() },
    board_posts: { findUnique: jest.fn(), updateMany: jest.fn() },
    photo_checks: { findUnique: jest.fn() },
    audit_logs: { create: jest.fn() },
    $queryRaw: jest.fn(),
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(jest.requireMock("@/lib/db").db)),
  },
}))

import { checkImageContent, type ModerationCheck } from "@/lib/moderation/openai-moderation"
import { recordPhotoPulled } from "@/lib/photo-checks"
import { ownedPhotoKey, sealedChatKey, withdrawFromPublic } from "@/lib/tigris"
import { notifyStaff } from "@/lib/staff-alert"
import { auditInTx } from "@/lib/audit-log"
import { logger } from "@/lib/logger"
import { db } from "@/lib/db"
import { moderateBlurPhoto, moderateProfilePhoto } from "@/lib/photos"
import { moderateLobbyPhoto } from "@/lib/lobby-photo"
import { holdSexualImage } from "@/lib/moderation/sexual-image-hold"

const USER = "4b8f8a52-7a0e-4c39-9d0b-0a3c2f1e5d11"
const PROFILE_KEY = `profile/${USER}/1764100000000-ab12cd-sealed`
const PROFILE_URL = `https://blendn-media.fly.storage.tigris.dev/${PROFILE_KEY}`
const BLUR_KEY = `profile/${USER}/1764100000001-ef34gh-sealed`
const BLUR_URL = `https://blendn-media.fly.storage.tigris.dev/${BLUR_KEY}`
const POST = "9c1d2e3f-0000-4000-8000-000000000001"
const LOBBY_KEY = "chat/sealed/0f0e0d0c-0b0a-4909-8807-060504030201"
const LOBBY_URL = `https://blendn-media-private.fly.storage.tigris.dev/${LOBBY_KEY}`

const SEXUAL_HIDE: ModerationCheck = {
  checked: true,
  result: { action: "hide", source: "openai_image", categories: { sexual: 0.92 }, confidence: 0.92 },
}
const VIOLENCE_HIDE: ModerationCheck = {
  checked: true,
  result: { action: "hide", source: "openai_image", categories: { violence: 0.9 }, confidence: 0.9 },
}
const SEXUAL_FLAG: ModerationCheck = {
  checked: true,
  result: { action: "flag", source: "openai_image", categories: { sexual: 0.5 }, confidence: 0.5 },
}

const vendor = checkImageContent as jest.Mock
const page = notifyStaff as jest.Mock
const audit = auditInTx as jest.Mock
const pulled = recordPhotoPulled as jest.Mock
const withdraw = withdrawFromPublic as jest.Mock
const lobbyCheck = jest.fn()

/** One image path: how to run it with a verdict, the key it names, and what "pulled" means on it. */
interface ImagePath {
  name: string
  path: "profile" | "blur" | "lobby"
  key: string
  run: (check: ModerationCheck) => Promise<unknown>
  expectPulled: () => void
}

const PATHS: ImagePath[] = [
  {
    name: "profile photo",
    path: "profile",
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
    path: "blur",
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
    path: "lobby",
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
  audit.mockResolvedValue(undefined)
})

const message = (path: string, key: string) =>
  `Sexual image pulled (${path}). A person must check it for a minor or a non-consensual image. key ${key} user ${USER}\nhttps://dash.test/dashboard/moderation`
const auditEntry = (path: string, key: string, category = "sexual") => ({
  action: "moderation.sexual_image_hold",
  resource: "user",
  resourceId: USER,
  details: { objectKey: key, path, category },
})

describe.each(PATHS)("an image hide naming sexual on the $name", (path) => {
  it("pulls it, pages staff once with the sentence, key, user id and link only, and writes the audit row", async () => {
    await path.run(SEXUAL_HIDE)

    path.expectPulled()
    expect(page).toHaveBeenCalledTimes(1)
    expect(page).toHaveBeenCalledWith(message(path.path, path.key))
    expect(audit).toHaveBeenCalledTimes(1)
    // No actor: the platform did this, as for every automated row (lib/audit-log.ts `actsFor`).
    expect(audit).toHaveBeenCalledWith(expect.anything(), auditEntry(path.path, path.key))
  })

  it("pages only after the photo is pulled", async () => {
    await path.run(SEXUAL_HIDE)
    const pullCall = path.path === "lobby" ? (db.board_posts.updateMany as jest.Mock) : withdraw
    expect(pullCall.mock.invocationCallOrder[0]).toBeLessThan(page.mock.invocationCallOrder[0])
  })

  it("a hide for another category (violence) pulls it and pages nobody", async () => {
    await path.run(VIOLENCE_HIDE)
    path.expectPulled()
    expect(page).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })

  it("a sexual score at flag level is judged as today and pages nobody", async () => {
    await path.run(SEXUAL_FLAG)
    expect(page).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })

  it.each(["failed", "unconfigured"])("a page that comes back %s leaves the photo pulled and logs an error", async (result) => {
    page.mockResolvedValue(result)
    await path.run(SEXUAL_HIDE)

    path.expectPulled()
    expect(audit).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith("Sexual image hold: staff were not paged", { userId: USER, objectKey: path.key, result })
  })

  it("an audit write that fails leaves the photo pulled, still pages, and logs an error naming the user and key", async () => {
    audit.mockRejectedValue(new Error("audit down"))
    await path.run(SEXUAL_HIDE)

    path.expectPulled()
    expect(page).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith("Sexual image hold: audit row not written", { userId: USER, objectKey: path.key, error: "audit down" })
  })
})

describe("holdSexualImage", () => {
  it("never runs for a text verdict naming sexual", async () => {
    await holdSexualImage({ checked: true, result: { ...SEXUAL_HIDE.result!, source: "openai_text" } }, "profile", PROFILE_KEY, USER)
    expect(page).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })

  it("runs for sexual/minors too, should the vendor ever score it on images", async () => {
    await holdSexualImage({ checked: true, result: { action: "hide", source: "openai_image", categories: { "sexual/minors": 0.8 }, confidence: 0.8 } }, "lobby", LOBBY_KEY, USER)
    expect(page).toHaveBeenCalledTimes(1)
    expect(audit).toHaveBeenCalledWith(expect.anything(), auditEntry("lobby", LOBBY_KEY, "sexual/minors"))
  })

  it("never throws: a page that throws is logged, and the call resolves", async () => {
    page.mockRejectedValue(new Error("channel exploded"))
    await expect(holdSexualImage(SEXUAL_HIDE, "profile", PROFILE_KEY, USER)).resolves.toBeUndefined()
    expect(logger.error).toHaveBeenCalledWith("Sexual image hold failed", { userId: USER, objectKey: PROFILE_KEY, error: "channel exploded" })
  })
})

describe("holdSexualImage, the edges", () => {
  const hide = (categories: Record<string, number>): ModerationCheck => ({
    checked: true,
    result: { action: "hide", source: "openai_image", categories, confidence: 0.9 },
  })

  it("another category's hide that also names sexual pages, and sexual/minors is the category it records", async () => {
    await holdSexualImage(hide({ violence: 0.9, sexual: 0.45 }), "profile", PROFILE_KEY, USER)
    await holdSexualImage(hide({ sexual: 0.9, "sexual/minors": 0.5 }), "blur", BLUR_KEY, USER)
    expect(page).toHaveBeenCalledTimes(2)
    expect(audit.mock.calls.map(([, entry]) => entry.details.category)).toEqual(["sexual", "sexual/minors"])
  })

  it("the staging override's hide pages nobody", async () => {
    await holdSexualImage(hide({ staging_override: 1 }), "profile", PROFILE_KEY, USER)
    expect(page).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })

  it("a key it could not resolve still pages and writes the row, and says so at error", async () => {
    await holdSexualImage(SEXUAL_HIDE, "lobby", null, USER)
    expect(page).toHaveBeenCalledTimes(1)
    expect(audit).toHaveBeenCalledWith(expect.anything(), auditEntry("lobby", null as unknown as string))
    expect(logger.error).toHaveBeenCalledWith("Sexual image hold: the object key could not be resolved", { userId: USER, objectKey: null })
  })

  it("the real audit writer stores the platform's row: no actor, no address, no organisation", async () => {
    audit.mockImplementation(jest.requireActual("@/lib/audit-log").auditInTx)
    await holdSexualImage(SEXUAL_HIDE, "profile", PROFILE_KEY, USER)
    expect(db.audit_logs.create).toHaveBeenCalledWith({
      data: {
        user_id: null,
        action: "moderation.sexual_image_hold",
        resource: "user",
        resource_id: USER,
        details: { objectKey: PROFILE_KEY, path: "profile", category: "sexual" },
        ip_address: null,
        org_id: null,
      },
    })
  })
})

describe("the page is never lost to a pull that fails", () => {
  it("a profile pull that throws still pages, and the failure is logged", async () => {
    pulled.mockRejectedValueOnce(new Error("deadlock detected"))
    vendor.mockResolvedValue(SEXUAL_HIDE)

    await moderateProfilePhoto(PROFILE_URL, USER)

    expect(page).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith(
      "Profile photo moderation failed; photo left in place",
      expect.objectContaining({ userId: USER, error: "deadlock detected" })
    )
  })

  it("a blur pull that throws still pages, and the failure is logged", async () => {
    pulled.mockRejectedValueOnce(new Error("deadlock detected"))
    vendor.mockResolvedValue(SEXUAL_HIDE)

    await moderateBlurPhoto(BLUR_URL, USER)

    expect(page).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith(
      "Blurred photo moderation failed; left in place",
      expect.objectContaining({ userId: USER, error: "deadlock detected" })
    )
  })

  it("a Lobby photo another pass already decided pages nobody: that pass did", async () => {
    ;(db.board_posts.updateMany as jest.Mock).mockResolvedValue({ count: 0 })
    lobbyCheck.mockResolvedValue(SEXUAL_HIDE)

    await moderateLobbyPhoto(POST, lobbyCheck)

    expect(page).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })
})
