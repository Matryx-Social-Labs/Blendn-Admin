import { generateKeyPairSync } from "crypto"
import jwt from "jsonwebtoken"
import { appleClientSecret, revokeAppleAuthorization } from "@/lib/apple-revoke"
import { appleRevokeConfig } from "@/lib/env"

/*
 * Sign in with Apple revoke on account deletion (5.1.1(v)). The client secret
 * is the part Apple rejects silently with `invalid_client` when one claim is
 * off, so its shape is pinned claim by claim, and verified with the key's
 * public half.
 */
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
const CONFIG = { teamId: "TEAM123456", keyId: "KEY1234567", privateKey: PEM, clientId: "com.matryxsociallabs.blendn" }
const saved = { ...process.env }
const SUB = "001234.abcdef.0420"
const LINKED: ReadonlySet<string> = new Set([SUB])
/** Apple's id_token as the exchange returns it; only `sub` is read. */
const idToken = (sub: string) => jwt.sign({ sub, iss: "https://appleid.apple.com" }, "not-checked")

afterEach(() => {
  process.env = { ...saved }
  jest.restoreAllMocks()
})

function configure() {
  process.env.APPLE_TEAM_ID = CONFIG.teamId
  process.env.APPLE_KEY_ID = CONFIG.keyId
  // As Railway holds a pasted .p8: one line, literal \n.
  process.env.APPLE_PRIVATE_KEY = PEM.replace(/\n/g, "\\n")
}

describe("appleClientSecret", () => {
  it("is an ES256 JWT with Apple's claims, signed by the key", () => {
    const secret = appleClientSecret(CONFIG, 1_800_000_000)
    const decoded = jwt.decode(secret, { complete: true })!
    expect(decoded.header).toEqual({ alg: "ES256", kid: "KEY1234567", typ: "JWT" })
    expect(decoded.payload).toEqual({
      iss: "TEAM123456",
      iat: 1_800_000_000,
      exp: 1_800_000_300,
      aud: "https://appleid.apple.com",
      sub: "com.matryxsociallabs.blendn",
    })
    expect(() => jwt.verify(secret, publicKey, { algorithms: ["ES256"], ignoreExpiration: true })).not.toThrow()
  })
})

describe("appleRevokeConfig", () => {
  it("is null unless the team, key id and key are all set", () => {
    delete process.env.APPLE_TEAM_ID
    delete process.env.APPLE_KEY_ID
    delete process.env.APPLE_PRIVATE_KEY
    expect(appleRevokeConfig()).toBeNull()
    configure()
    delete process.env.APPLE_KEY_ID
    expect(appleRevokeConfig()).toBeNull()
  })

  it("restores a one-line key's newlines and defaults the client id to the bundle id", () => {
    configure()
    delete process.env.APPLE_BUNDLE_ID
    expect(appleRevokeConfig()).toEqual({ ...CONFIG, privateKey: PEM.trim() })
  })
})

describe("revokeAppleAuthorization", () => {
  const answer = (status: number, body: unknown) =>
    ({ ok: status < 400, status, text: async () => JSON.stringify(body) }) as unknown as Response

  it("skips without a code or without the key, and calls nobody", async () => {
    const fetchSpy = jest.spyOn(global, "fetch")
    expect(await revokeAppleAuthorization(undefined, LINKED)).toEqual({ outcome: "skipped", reason: "no_code" })
    delete process.env.APPLE_TEAM_ID
    expect(await revokeAppleAuthorization("c0de", LINKED)).toEqual({ outcome: "skipped", reason: "not_configured" })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("exchanges the code, then revokes the refresh token", async () => {
    configure()
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(answer(200, { access_token: "at", refresh_token: "rt", id_token: idToken(SUB) }))
      .mockResolvedValueOnce(answer(200, {}))
    expect(await revokeAppleAuthorization("c0de", LINKED)).toEqual({ outcome: "revoked" })

    const [tokenUrl, tokenInit] = fetchSpy.mock.calls[0]
    expect(tokenUrl).toBe("https://appleid.apple.com/auth/token")
    const exchange = new URLSearchParams(String(tokenInit!.body))
    expect(exchange.get("grant_type")).toBe("authorization_code")
    expect(exchange.get("code")).toBe("c0de")
    expect(exchange.get("client_id")).toBe("com.matryxsociallabs.blendn")
    expect(jwt.verify(exchange.get("client_secret")!, publicKey, { algorithms: ["ES256"] })).toMatchObject({ iss: "TEAM123456" })

    const [revokeUrl, revokeInit] = fetchSpy.mock.calls[1]
    expect(revokeUrl).toBe("https://appleid.apple.com/auth/revoke")
    const revoke = new URLSearchParams(String(revokeInit!.body))
    expect(revoke.get("token")).toBe("rt")
    expect(revoke.get("token_type_hint")).toBe("refresh_token")
  })

  it("falls back to the access token when Apple returns no refresh token", async () => {
    configure()
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(answer(200, { access_token: "at", id_token: idToken(SUB) }))
      .mockResolvedValueOnce(answer(200, {}))
    expect(await revokeAppleAuthorization("c0de", LINKED)).toEqual({ outcome: "revoked" })
    const revoke = new URLSearchParams(String(fetchSpy.mock.calls[1][1]!.body))
    expect(revoke.get("token")).toBe("at")
    expect(revoke.get("token_type_hint")).toBe("access_token")
  })

  it("revokes nothing when the code is for a different Apple ID, and names neither", async () => {
    configure()
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(answer(200, { access_token: "at", refresh_token: "rt", id_token: idToken("000999.other.0001") }))
    const result = await revokeAppleAuthorization("c0de", LINKED)
    expect(result).toEqual({ outcome: "skipped", reason: "different_apple_id" })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(result)).not.toMatch(/000999|001234/)
  })

  it("revokes nothing when Apple's answer has no id_token to check", async () => {
    configure()
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValueOnce(answer(200, { access_token: "at", refresh_token: "rt" }))
    expect(await revokeAppleAuthorization("c0de", LINKED)).toEqual({ outcome: "failed", reason: "no id_token sub in Apple’s answer" })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it("fails without throwing, and the reason carries no code or token", async () => {
    configure()
    jest.spyOn(global, "fetch").mockResolvedValueOnce(answer(400, { error: "invalid_grant", detail: "c0de" }))
    const result = await revokeAppleAuthorization("c0de", LINKED)
    expect(result).toEqual({ outcome: "failed", reason: "/auth/token answered 400 (invalid_grant)" })

    jest.spyOn(global, "fetch").mockRejectedValueOnce(new Error("network down"))
    expect(await revokeAppleAuthorization("c0de", LINKED)).toEqual({ outcome: "failed", reason: "network down" })
  })
})
