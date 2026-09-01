import {
  checkSpam,
  resetSpamHistory,
  clearAllSpamHistory,
} from "@/lib/moderation/spam-detector"

describe("checkSpam", () => {
  const userId = "user-1"
  const chatGroupId = "group-1"

  afterEach(async () => {
    await clearAllSpamHistory()
  })

  it("allows a normal message", async () => {
    const result = await checkSpam(userId, chatGroupId, "Hello everyone!")
    expect(result).toBeNull()
  })

  it("detects burst rate (too many messages)", async () => {
    // Send messages up to the limit
    for (let i = 0; i < 5; i++) {
      await checkSpam(userId, chatGroupId, `Message ${i}`)
    }
    // The 6th should be flagged
    const result = await checkSpam(userId, chatGroupId, "One more message")
    expect(result).not.toBeNull()
    expect(result!.source).toBe("spam")
    expect(result!.reason).toContain("Burst rate")
    expect(result!.action).toBe("hide")
  })

  it("detects duplicate messages", async () => {
    await checkSpam(userId, chatGroupId, "Buy cheap products now!")
    const result = await checkSpam(userId, chatGroupId, "Buy cheap products now!")
    expect(result).not.toBeNull()
    expect(result!.source).toBe("spam")
    expect(result!.reason).toContain("Duplicate")
  })

  it("detects near-duplicate messages", async () => {
    await checkSpam(userId, chatGroupId, "Check out this amazing deal on products")
    const result = await checkSpam(
      userId,
      chatGroupId,
      "Check out this amazing deal on products!"
    )
    expect(result).not.toBeNull()
    expect(result!.reason).toContain("Duplicate")
  })

  it("detects excessive links", async () => {
    const result = await checkSpam(
      userId,
      chatGroupId,
      "Visit https://spam1.com and https://spam2.com and https://spam3.com"
    )
    expect(result).not.toBeNull()
    expect(result!.reason).toContain("links")
    expect(result!.action).toBe("hide")
  })

  it("allows messages with up to 2 links", async () => {
    const result = await checkSpam(
      userId,
      chatGroupId,
      "Check https://example.com and https://docs.com"
    )
    expect(result).toBeNull()
  })

  it("tracks different users independently", async () => {
    for (let i = 0; i < 5; i++) {
      await checkSpam("user-a", chatGroupId, `Message ${i}`)
    }
    // User B should still be fine
    const result = await checkSpam("user-b", chatGroupId, "Hello!")
    expect(result).toBeNull()
  })

  it("tracks different chat groups independently", async () => {
    for (let i = 0; i < 5; i++) {
      await checkSpam(userId, "group-a", `Message ${i}`)
    }
    // Same user in different group should be fine
    const result = await checkSpam(userId, "group-b", "Hello!")
    expect(result).toBeNull()
  })

  it("resets spam history", async () => {
    for (let i = 0; i < 5; i++) {
      await checkSpam(userId, chatGroupId, `Message ${i}`)
    }
    await resetSpamHistory(userId, chatGroupId)
    const result = await checkSpam(userId, chatGroupId, "Fresh start")
    expect(result).toBeNull()
  })
})
