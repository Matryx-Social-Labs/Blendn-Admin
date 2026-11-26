/**
 * The mobile upload routes serve the attendee app, which uploads and deletes
 * only `profile` and `chat` media (SCRUM-1250). Event media is the dashboard's
 * (`/api/uploads/presigned-url`, behind a dashboard session); a non-attendee
 * never holds a mobile token (`lib/mobile-auth.ts`), so `folder: "events"` on
 * the mobile presign only ever reached a role check nobody could pass, and the
 * mobile delete let anybody who once uploaded event media remove it from a
 * live event after leaving the dashboard.
 */
import { NextRequest } from "next/server"

process.env.TIGRIS_ENDPOINT = "https://storage.test"
process.env.TIGRIS_ACCESS_KEY = "ak"
process.env.TIGRIS_SECRET_KEY = "sk"

const USER = "user-1"
const mockDeleteFile = jest.fn(async (key: string) => key)

jest.mock("@/lib/mobile-auth", () => ({ getAuthenticatedUser: async () => ({ userId: "user-1" }) }))
jest.mock("@/lib/rate-limit", () => ({ rateLimit: async () => null, userLimit: () => ({}) }))
jest.mock("@/lib/db", () => ({ db: {} }))
jest.mock("@/lib/tigris", () => ({ ...jest.requireActual("@/lib/tigris"), deleteFile: (key: string) => mockDeleteFile(key) }))

import { POST as presign } from "@/app/api/mobile/uploads/presigned-url/route"
import { DELETE as remove } from "@/app/api/mobile/uploads/delete/route"

const request = (method: string, body: unknown) =>
  new NextRequest("http://localhost/x", { method, body: JSON.stringify(body) })

const photo = { filename: "a.jpg", contentType: "image/jpeg", size: 100 }
const host = "https://blendn-media.fly.storage.tigris.dev"

describe("mobile presigned-url", () => {
  it("signs a profile upload (control)", async () => {
    expect((await presign(request("POST", { ...photo, folder: "profile" }))).status).toBe(200)
  })

  it("refuses folder events with a 400: the app has no event uploads", async () => {
    expect((await presign(request("POST", { ...photo, folder: "events" }))).status).toBe(400)
  })
})

describe("mobile uploads/delete", () => {
  beforeEach(() => mockDeleteFile.mockClear())

  it("deletes the caller's own profile photo (control)", async () => {
    const res = await remove(request("DELETE", { url: `${host}/profile/${USER}/1-a.jpg` }))
    expect(res.status).toBe(200)
    expect(mockDeleteFile).toHaveBeenCalledWith(`profile/${USER}/1-a.jpg`)
  })

  it("refuses the caller's own event media with a 403 and deletes nothing", async () => {
    const res = await remove(request("DELETE", { url: `${host}/events/${USER}/1-a.jpg` }))
    expect(res.status).toBe(403)
    expect(mockDeleteFile).not.toHaveBeenCalled()
  })
})
