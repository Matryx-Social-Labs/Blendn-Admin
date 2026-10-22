/*
 * Only a confirmed 404 is "gone" (SCRUM-732). The sweep deletes a record on
 * the strength of that word, so the network, a 5xx and a permissions error
 * must come out as "could not tell", never as gone.
 */
process.env.TIGRIS_ENDPOINT = "https://fly.storage.tigris.dev"
process.env.TIGRIS_ACCESS_KEY = "test-access"
process.env.TIGRIS_SECRET_KEY = "test-secret"
process.env.TIGRIS_BUCKET = "blendn-media-test"

const send = jest.fn()
jest.mock("@aws-sdk/client-s3", () => {
  const actual = jest.requireActual("@aws-sdk/client-s3")
  return { ...actual, S3Client: jest.fn().mockImplementation(() => ({ send, config: {} })) }
})

import { objectPresence } from "@/lib/tigris"

const failure = (name: string, status?: number) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } })
beforeEach(() => send.mockReset())

describe("objectPresence", () => {
  it("says present for an object that is there", async () => {
    send.mockResolvedValue({})
    expect(await objectPresence("profile/u/x")).toBe("present")
  })

  it("says gone for a confirmed 404", async () => {
    send.mockRejectedValue(failure("NotFound", 404))
    expect(await objectPresence("profile/u/x")).toBe("gone")
  })

  it.each([
    ["a 403", failure("Forbidden", 403)],
    ["a 500", failure("InternalError", 500)],
    ["a 503", failure("ServiceUnavailable", 503)],
    ["a network failure", failure("TimeoutError")],
  ])("says unknown, not gone, for %s", async (_label, error) => {
    send.mockRejectedValue(error)
    expect(await objectPresence("profile/u/x")).toBe("unknown")
  })
})
