const mockDb = {
  leads: { findUnique: jest.fn() },
  organiser_onboarding_requests: { findFirst: jest.fn() },
}
const mockSendEmail = jest.fn()
const mockEmailConfigured = jest.fn()

jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/email", () => ({
  sendEmail: (...a: unknown[]) => mockSendEmail(...a),
  emailConfigured: () => mockEmailConfigured(),
  appUrl: () => "https://api.blendn.app",
}))

import { notifyNewLead } from "@/lib/lead-notify"

const LEAD = {
  id: "lead_1",
  email: "sam@example.com",
  name: "Sam Rivera",
  organization: "Northside Collective",
  city: "Bengaluru",
  event_types: "club nights",
  source: "organizers-landing",
}

const WEBHOOK = "https://hooks.slack.com/services/T000/B000/xxxx"
const ENV = { ...process.env }

let fetchMock: jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  process.env = { ...ENV }
  delete process.env.LEADS_SLACK_WEBHOOK_URL
  delete process.env.LEADS_NOTIFY_EMAIL
  mockDb.leads.findUnique.mockResolvedValue(LEAD)
  mockDb.organiser_onboarding_requests.findFirst.mockResolvedValue(null)
  mockEmailConfigured.mockReturnValue(true)
  mockSendEmail.mockResolvedValue({ ok: true })
  fetchMock = jest.fn().mockResolvedValue({ ok: true, text: async () => "ok" })
  global.fetch = fetchMock as unknown as typeof fetch
})

afterAll(() => {
  process.env = ENV
})

/**
 * A stored lead nobody hears about is the Supabase table nobody read, with
 * extra steps. These tests are about the alert surviving things going wrong —
 * the lead is already saved by the time this runs, so a failing notifier must
 * never turn a successful ingest into an error the visitor sees.
 */

describe("channel selection", () => {
  it("does nothing, loudly enough to find, when neither is configured", async () => {
    await expect(notifyNewLead("lead_1")).resolves.toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mockSendEmail).not.toHaveBeenCalled()
    // Not even a database read — unconfigured should cost nothing.
    expect(mockDb.leads.findUnique).not.toHaveBeenCalled()
  })

  it("posts to Slack alone when only the webhook is set", async () => {
    process.env.LEADS_SLACK_WEBHOOK_URL = WEBHOOK
    await notifyNewLead("lead_1")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it("emails alone when only the address is set", async () => {
    process.env.LEADS_NOTIFY_EMAIL = "ops@blendn.app"
    await notifyNewLead("lead_1")
    expect(mockSendEmail).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("does both when both are set", async () => {
    process.env.LEADS_SLACK_WEBHOOK_URL = WEBHOOK
    process.env.LEADS_NOTIFY_EMAIL = "ops@blendn.app"
    await notifyNewLead("lead_1")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(mockSendEmail).toHaveBeenCalledTimes(1)
  })

  it("skips email when the address is set but Resend is not", async () => {
    process.env.LEADS_NOTIFY_EMAIL = "ops@blendn.app"
    mockEmailConfigured.mockReturnValue(false)
    await notifyNewLead("lead_1")
    expect(mockSendEmail).not.toHaveBeenCalled()
  })
})

describe("one channel failing must not cost the other", () => {
  beforeEach(() => {
    process.env.LEADS_SLACK_WEBHOOK_URL = WEBHOOK
    process.env.LEADS_NOTIFY_EMAIL = "ops@blendn.app"
  })

  it("still emails when Slack returns an error", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => "invalid_token" })
    await expect(notifyNewLead("lead_1")).resolves.toBeUndefined()
    expect(mockSendEmail).toHaveBeenCalledTimes(1)
  })

  it("still emails when Slack throws outright", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"))
    await expect(notifyNewLead("lead_1")).resolves.toBeUndefined()
    expect(mockSendEmail).toHaveBeenCalledTimes(1)
  })

  it("still posts to Slack when email throws", async () => {
    mockSendEmail.mockRejectedValue(new Error("Resend down"))
    await expect(notifyNewLead("lead_1")).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("never rejects, even when both fail", async () => {
    // The caller does `void notifyNewLead(...)` after the write. A rejection
    // here would be an unhandled rejection, which on Node 15+ kills the process.
    fetchMock.mockRejectedValue(new Error("nope"))
    mockSendEmail.mockRejectedValue(new Error("also nope"))
    await expect(notifyNewLead("lead_1")).resolves.toBeUndefined()
  })
})

describe("what the message says", () => {
  beforeEach(() => {
    process.env.LEADS_SLACK_WEBHOOK_URL = WEBHOOK
  })

  it("carries a plain-text fallback as well as blocks", async () => {
    // A phone notification reading "[no preview]" defeats the point of sending
    // it immediately.
    await notifyNewLead("lead_1")
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.text).toContain("Sam Rivera")
    expect(Array.isArray(body.blocks)).toBe(true)
  })

  it("deep-links to the drawer, not just the list", async () => {
    await notifyNewLead("lead_1")
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    const button = body.blocks.find((b: { type: string }) => b.type === "actions")
    expect(button.elements[0].url).toBe("https://api.blendn.app/dashboard/leads?lead=lead_1")
  })

  it("says when the person has already applied", async () => {
    // The highest-value fact in the message: it changes who picks the lead up
    // and what they say first.
    mockDb.organiser_onboarding_requests.findFirst.mockResolvedValue({ status: "approved" })
    await notifyNewLead("lead_1")
    expect(JSON.stringify(fetchMock.mock.calls[0][1].body)).toContain("approved")
  })

  it("says explicitly when they have not", async () => {
    await notifyNewLead("lead_1")
    expect(fetchMock.mock.calls[0][1].body).toContain("No application from this address yet")
  })

  it("falls back to the email when there is no name", async () => {
    mockDb.leads.findUnique.mockResolvedValue({ ...LEAD, name: null })
    await notifyNewLead("lead_1")
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).text).toContain("sam@example.com")
  })

  it("omits optional fields rather than printing empty labels", async () => {
    mockDb.leads.findUnique.mockResolvedValue({ ...LEAD, city: null, event_types: null })
    await notifyNewLead("lead_1")
    const body = fetchMock.mock.calls[0][1].body
    expect(body).not.toContain("*City*")
    expect(body).not.toContain("*Runs*")
  })

  it("does nothing for a lead that no longer exists", async () => {
    mockDb.leads.findUnique.mockResolvedValue(null)
    await notifyNewLead("gone")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
