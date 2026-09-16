import { readFileSync } from "fs"
import { join } from "path"

import { stripComments } from "./support/strip-comments"

/**
 * A venue claim's licence is readable by the reviewer and by nobody else.
 *
 * Found on staging (SCRUM-135): the trade licence attached to a claim was
 * uploaded under `events/` — the folder for covers — and fetched with no
 * cookie and no token returned 200. The bucket policy granted anonymous read
 * on the whole bucket, so every private document was public the moment it
 * landed. The policy now names the public folders; `claims/` is private by
 * omission, and the queue reads it through a signed URL.
 */

// The S3 client is built from env at import time; a fake endpoint is enough
// because the presigner is mocked below and nothing is sent.
process.env.TIGRIS_ENDPOINT = "https://t3.storage.dev"
process.env.TIGRIS_ACCESS_KEY = "test"
process.env.TIGRIS_SECRET_KEY = "test"
process.env.TIGRIS_BUCKET = "blendn-media-test"

const signed = jest.fn(async (_client: unknown, command: { input: { Key: string } }) =>
  `https://signed.example/${command.input.Key}?X-Amz-Signature=abc`
)
jest.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: (...a: unknown[]) => signed(...(a as [unknown, { input: { Key: string } }])) }))

// The S3 client itself is mocked so `ensureBucketExists` runs its real boot
// path — HeadBucket, then the policy — and the policy it would PUT is captured.
const sent: unknown[] = []
jest.mock("@aws-sdk/client-s3", () => {
  const cmd = (name: string) =>
    class {
      readonly name = name
      constructor(public readonly input: Record<string, unknown>) {}
    }
  return {
    S3Client: class {
      async send(command: unknown) {
        sent.push(command)
        return {}
      }
    },
    HeadBucketCommand: cmd("HeadBucket"),
    CreateBucketCommand: cmd("CreateBucket"),
    PutBucketCorsCommand: cmd("PutBucketCors"),
    PutBucketPolicyCommand: cmd("PutBucketPolicy"),
    PutObjectCommand: cmd("PutObject"),
    GetObjectCommand: cmd("GetObject"),
    HeadObjectCommand: cmd("HeadObject"),
    DeleteObjectCommand: cmd("DeleteObject"),
    DeleteObjectsCommand: cmd("DeleteObjects"),
    ListObjectsV2Command: cmd("ListObjectsV2"),
  }
})

import { PUBLIC_FOLDERS, ensureBucketExists, reviewableUrl, validateContentType } from "@/lib/tigris"

const ROOT = join(__dirname, "..")
const code = (p: string) => stripComments(readFileSync(join(ROOT, p), "utf8"))

describe("the bucket policy, as applied on every boot", () => {
  let resources: string[]

  beforeAll(async () => {
    await ensureBucketExists()
    const put = sent.find((c) => (c as { name: string }).name === "PutBucketPolicy") as
      | { input: { Policy: string } }
      | undefined
    expect(put).toBeDefined()
    resources = JSON.parse(put!.input.Policy).Statement[0].Resource
  })

  it("grants anonymous read on the public folders only — never the bucket root", () => {
    expect(resources).toEqual(PUBLIC_FOLDERS.map((f) => `arn:aws:s3:::blendn-media-test/${f}/*`))
    expect(resources).not.toContain("arn:aws:s3:::blendn-media-test/*")
  })

  it("leaves claims out", () => {
    expect(PUBLIC_FOLDERS).not.toContain("claims")
    expect(resources.some((r) => r.includes("/claims/"))).toBe(false)
  })
})

describe("what a reviewer is handed", () => {
  beforeEach(() => signed.mockClear())

  it("signs a private key and leaves a public one alone", async () => {
    const bucket = "blendn-media-test"
    const priv = `https://${bucket}.fly.storage.tigris.dev/claims/user1/1-abc-licence.pdf`
    const pub = `https://${bucket}.fly.storage.tigris.dev/events/user1/1-abc-cover.jpg`

    await expect(reviewableUrl(priv)).resolves.toContain("X-Amz-Signature")
    expect(signed).toHaveBeenCalledTimes(1)
    expect(signed.mock.calls[0][1].input.Key).toBe("claims/user1/1-abc-licence.pdf")

    // Evidence filed before `claims/` existed, and a link the claimant pasted.
    await expect(reviewableUrl(pub)).resolves.toBe(pub)
    await expect(reviewableUrl("https://example.com/licence.pdf")).resolves.toBe("https://example.com/licence.pdf")
    expect(signed).toHaveBeenCalledTimes(1)
  })
})

describe("what may be uploaded there", () => {
  it("accepts a scan or a photo of a licence and nothing that plays", () => {
    expect(validateContentType("application/pdf", "claims")).toBe(true)
    expect(validateContentType("image/jpeg", "claims")).toBe(true)
    expect(validateContentType("video/mp4", "claims")).toBe(false)
  })
})

describe("the form", () => {
  it("uploads evidence to the private folder, and the queue reads it through the signer", () => {
    expect(code("components/venue-claim-form.tsx")).toMatch(/uploadFile\(file, undefined, "claims"\)/)
    expect(code("lib/venue-claim-actions.ts")).toMatch(/reviewableUrl\(/)
    expect(code("app/api/uploads/presigned-url/route.ts")).toMatch(/"claims"/)
  })
})
