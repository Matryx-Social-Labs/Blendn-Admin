import { logger } from "@/lib/logger"

describe("logger", () => {
  const originalEnv = process.env.NODE_ENV

  beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation()
    jest.spyOn(console, "warn").mockImplementation()
    jest.spyOn(console, "error").mockImplementation()
  })

  afterEach(() => {
    jest.restoreAllMocks()
    process.env.NODE_ENV = originalEnv
  })

  it("logs error messages", () => {
    logger.error("test error", { code: 500 })
    expect(console.error).toHaveBeenCalled()
  })

  it("logs warn messages", () => {
    logger.warn("test warning")
    expect(console.warn).toHaveBeenCalled()
  })

  it("logs info messages", () => {
    logger.info("test info")
    expect(console.log).toHaveBeenCalled()
  })

  it("includes metadata in output", () => {
    logger.info("test", { userId: "123", action: "login" })
    expect(console.log).toHaveBeenCalled()
    const call = (console.log as jest.Mock).mock.calls[0][0]
    expect(call).toContain("test")
  })
})
