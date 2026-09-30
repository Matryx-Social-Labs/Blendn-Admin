/**
 * `withdrawFromPublic` keeps a pulled photo and takes it off its public URL
 * (SCRUM-479). The order is the whole contract: copy into the private bucket,
 * then delete the public one. Deleting first, or after a copy that failed,
 * destroys removed content that is kept 180 days (docs/RETENTION.md).
 */
process.env.TIGRIS_ENDPOINT = "https://t3.storage.dev"
process.env.TIGRIS_ACCESS_KEY = "test"
process.env.TIGRIS_SECRET_KEY = "test"
process.env.TIGRIS_BUCKET = "blendn-media-test"

const sent: { name: string; input: Record<string, unknown> }[] = []
let copyFails: Error | null = null

jest.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: jest.fn() }))
jest.mock("@aws-sdk/client-s3", () => {
  const cmd = (name: string) =>
    class {
      readonly name = name
      constructor(public readonly input: Record<string, unknown>) {}
    }
  return {
    S3Client: class {
      async send(command: { name: string; input: Record<string, unknown> }) {
        sent.push(command)
        if (command.name === "CopyObject" && copyFails) throw copyFails
        return {}
      }
    },
    CopyObjectCommand: cmd("CopyObject"),
    DeleteObjectCommand: cmd("DeleteObject"),
    DeleteObjectsCommand: cmd("DeleteObjects"),
    GetObjectCommand: cmd("GetObject"),
    HeadObjectCommand: cmd("HeadObject"),
    ListObjectsV2Command: cmd("ListObjectsV2"),
    PutObjectCommand: cmd("PutObject"),
    CreateBucketCommand: cmd("CreateBucket"),
    HeadBucketCommand: cmd("HeadBucket"),
    PutBucketPolicyCommand: cmd("PutBucketPolicy"),
    PutBucketCorsCommand: cmd("PutBucketCors"),
  }
})

import { deleteFile, withdrawFromPublic } from "@/lib/tigris"

const KEY = "profile/u1/1790641297767-ab12cd-sealed"

beforeEach(() => {
  sent.length = 0
  copyFails = null
})

it("copies into the private bucket, then deletes the public object", async () => {
  await withdrawFromPublic(KEY)

  expect(sent.map((c) => [c.name, c.input.Bucket, c.input.Key])).toEqual([
    ["CopyObject", "blendn-media-test-private", KEY],
    ["DeleteObject", "blendn-media-test", KEY],
  ])
  expect(sent[0].input.CopySource).toBe(`blendn-media-test/${KEY}`)
})

it("deletes nothing when the copy fails", async () => {
  copyFails = Object.assign(new Error("slow down"), { name: "SlowDown", $metadata: { httpStatusCode: 503 } })

  await expect(withdrawFromPublic(KEY)).rejects.toThrow("slow down")
  expect(sent.map((c) => c.name)).toEqual(["CopyObject"])
})

it("throws when the private bucket is missing, rather than calling it withdrawn", async () => {
  copyFails = Object.assign(new Error("no bucket"), { name: "NoSuchBucket", $metadata: { httpStatusCode: 404 } })

  await expect(withdrawFromPublic(KEY)).rejects.toThrow("no bucket")
  expect(sent.map((c) => c.name)).toEqual(["CopyObject"])
})

it("a user's own delete never reaches the kept copy in the private bucket", async () => {
  // `DELETE /uploads/delete` calls this for any profile/<me>/ URL.
  await deleteFile(KEY)

  expect(sent.map((c) => [c.name, c.input.Bucket])).toEqual([["DeleteObject", "blendn-media-test"]])
})

it("is done already when the public object is gone", async () => {
  copyFails = Object.assign(new Error("gone"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } })

  await expect(withdrawFromPublic(KEY)).resolves.toBeUndefined()
  expect(sent.map((c) => c.name)).toEqual(["CopyObject"])
})
