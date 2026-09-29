/**
 * `deletePrefix` can keep named objects (SCRUM-428).
 *
 * Account deletion now erases `chat/<id>/` as well as `profile/<id>/`. But an
 * image in a message moderation hid, flagged or someone reported is removed
 * content, kept 180 days after its author leaves (docs/RETENTION.md, IT Rules
 * 2021 r.3(1)(g)). So the erasure takes a set of keys to leave in place.
 */
process.env.TIGRIS_ENDPOINT = "https://t3.storage.dev"
process.env.TIGRIS_ACCESS_KEY = "test"
process.env.TIGRIS_SECRET_KEY = "test"
process.env.TIGRIS_BUCKET = "blendn-media-test"

const sent: { name: string; input: Record<string, unknown> }[] = []
const listed = ["chat/u1/1-a.jpg", "chat/u1/2-b.jpg", "chat/u1/3-c.jpg"]
// One page by default; a test can split the listing and name keys the delete refuses.
// Chat media is in the private bucket (SCRUM-427); `legacy` is what is left in the public one.
const PRIVATE = "blendn-media-test-private"
let pages: string[][] = [listed]
let legacy: string[] = []
let refused: string[] = []

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
        if (command.name === "ListObjectsV2" && command.input.Bucket !== PRIVATE) {
          return { Contents: legacy.map((Key) => ({ Key })), IsTruncated: false }
        }
        if (command.name === "ListObjectsV2") {
          const i = command.input.ContinuationToken ? Number(command.input.ContinuationToken) : 0
          const more = i + 1 < pages.length
          return { Contents: pages[i].map((Key) => ({ Key })), IsTruncated: more, NextContinuationToken: more ? String(i + 1) : undefined }
        }
        if (command.name === "DeleteObjects") return { Errors: refused.map((Key) => ({ Key, Code: "AccessDenied" })) }
        return {}
      }
    },
    GetObjectCommand: cmd("GetObject"),
    HeadObjectCommand: cmd("HeadObject"),
    PutObjectCommand: cmd("PutObject"),
    DeleteObjectCommand: cmd("DeleteObject"),
    DeleteObjectsCommand: cmd("DeleteObjects"),
    ListObjectsV2Command: cmd("ListObjectsV2"),
    CreateBucketCommand: cmd("CreateBucket"),
    HeadBucketCommand: cmd("HeadBucket"),
    PutBucketCorsCommand: cmd("PutBucketCors"),
    PutBucketPolicyCommand: cmd("PutBucketPolicy"),
  }
})

import { deletePrefix } from "@/lib/tigris"

const deleted = () =>
  sent
    .filter((c) => c.name === "DeleteObjects")
    .flatMap((c) => ((c.input.Delete as { Objects: { Key: string }[] }).Objects ?? []).map((o) => o.Key))

beforeEach(() => {
  sent.length = 0
  pages = [listed]
  legacy = []
  refused = []
})

it("deletes everything under the prefix when told to keep nothing", async () => {
  expect(await deletePrefix("chat/u1/")).toBe(3)
  expect(deleted()).toEqual(listed)
})

it("leaves the keys it is told to keep, and counts only what it deleted", async () => {
  expect(await deletePrefix("chat/u1/", new Set(["chat/u1/2-b.jpg"]))).toBe(2)
  expect(deleted()).toEqual(["chat/u1/1-a.jpg", "chat/u1/3-c.jpg"])
})

it("sends no delete at all when everything listed is kept", async () => {
  expect(await deletePrefix("chat/u1/", new Set(listed))).toBe(0)
  expect(sent.some((c) => c.name === "DeleteObjects")).toBe(false)
})

it("honours the keep set on every page, and follows the continuation token", async () => {
  pages = [["chat/u1/1-a.jpg", "chat/u1/2-b.jpg"], ["chat/u1/3-c.jpg", "chat/u1/4-d.jpg"]]
  expect(await deletePrefix("chat/u1/", new Set(["chat/u1/4-d.jpg"]))).toBe(3)
  expect(deleted()).toEqual(["chat/u1/1-a.jpg", "chat/u1/2-b.jpg", "chat/u1/3-c.jpg"])
  const privateLists = sent.filter((c) => c.name === "ListObjectsV2" && c.input.Bucket === PRIVATE)
  expect(privateLists.map((c) => c.input.ContinuationToken)).toEqual([undefined, "1"])
})

it("does not count an object the store refused to delete", async () => {
  refused = ["chat/u1/2-b.jpg"]
  expect(await deletePrefix("chat/u1/")).toBe(2)
})

it("sweeps the public bucket too, where chat media lived before SCRUM-427, and keeps a retained key in both", async () => {
  legacy = ["chat/u1/0-old.jpg", "chat/u1/2-b.jpg"]
  const keep = new Set(["chat/u1/2-b.jpg"])
  expect(await deletePrefix("chat/u1/", keep)).toBe(3)
  const deletes = sent.filter((c) => c.name === "DeleteObjects")
  expect(deletes.map((c) => c.input.Bucket).sort()).toEqual(["blendn-media-test", PRIVATE])
  expect(deleted().sort()).toEqual(["chat/u1/0-old.jpg", "chat/u1/1-a.jpg", "chat/u1/3-c.jpg"])
})
