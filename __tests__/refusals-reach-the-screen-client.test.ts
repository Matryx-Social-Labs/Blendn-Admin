import { readdirSync, readFileSync, statSync } from "fs"
import { join } from "path"
import { errorResponse } from "@/lib/api-response"
import { Refusal } from "@/lib/refusal"
import { requestPresignedUrl } from "@/components/event-form/upload"

/*
 * A refused request says why, on the screens SCRUM-315 did not reach
 * (SCRUM-317).
 *
 * The upload slot route refuses in words — a content type it will not take,
 * the rate limit, storage switched off — and every caller showed "Failed to
 * upload cover image". Three chat and sponsored-message actions threw a bare
 * `new Error()` on a refusal, so the ban a moderator could not make, or the
 * message they could not delete, read as a generic failure.
 */
const HEIC = 'Content type "image/heic" is not allowed for events uploads'

describe("requestPresignedUrl", () => {
  const realFetch = global.fetch
  afterEach(() => {
    global.fetch = realFetch
  })

  it("rejects with the route's own sentence, as a Refusal the callers show", async () => {
    global.fetch = jest.fn().mockResolvedValue(errorResponse(HEIC, 400)) as typeof fetch
    const file = new File(["x"], "photo.heic", { type: "image/heic" })

    const err = await requestPresignedUrl(file).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Refusal)
    expect((err as Error).message).toBe(HEIC)
  })
})

describe("dashboard screens reading a refused response", () => {
  const ROOT = join(__dirname, "..")
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) return files(path)
      return /\.(tsx|ts)$/.test(name) ? [path] : []
    })
  }

  it("never throw a bare `new Error()` on a failed response — that drops the route's sentence", () => {
    const offenders = [...files(join(ROOT, "components")), ...files(join(ROOT, "app", "dashboard"))]
      .filter((f) => /if \(!\w+\.ok\) throw new Error\(\)/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(ROOT.length + 1))
    expect(offenders).toEqual([])
  })

  it("show a Refusal's words when an upload is refused", () => {
    for (const f of ["components/event-form/cover-image-section.tsx", "components/event-form.tsx", "components/venue-claim-form.tsx"]) {
      expect(readFileSync(join(ROOT, f), "utf8")).toMatch(/err instanceof Refusal \? err\.message :/)
    }
  })
})
