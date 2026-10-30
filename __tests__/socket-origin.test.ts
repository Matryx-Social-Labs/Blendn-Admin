import { socketOriginAllowed } from "@/lib/socket-origin"

/*
 * SCRUM-946. The dashboard socket authenticates with the session cookie, and a
 * WebSocket upgrade is not bound by CORS: any page in a sibling same-site
 * origin could open it as the signed-in user. A browser always sends Origin;
 * the native app sends none.
 */
const allowed = ["https://api.blendn.app", "https://blendn.app"]

describe("socketOriginAllowed", () => {
  it("lets a client with no Origin through (the native app)", () => {
    expect(socketOriginAllowed(undefined, "api.blendn.app", allowed)).toBe(true)
  })
  it("lets the allow-list through", () => {
    expect(socketOriginAllowed("https://blendn.app", "api.blendn.app", allowed)).toBe(true)
  })
  it("lets the page the socket is served from through, whatever the allow-list says", () => {
    expect(socketOriginAllowed("https://staging-dashboard.blendn.app", "staging-dashboard.blendn.app", allowed)).toBe(true)
  })
  it("refuses a sibling origin", () => {
    expect(socketOriginAllowed("https://evil.blendn.app", "staging-dashboard.blendn.app", allowed)).toBe(false)
    expect(socketOriginAllowed("https://staging-dashboard.blendn.app.evil.test", "staging-dashboard.blendn.app", allowed)).toBe(false)
  })
  it("refuses an Origin that is not a URL, and any Origin when the host is unknown", () => {
    expect(socketOriginAllowed("null", "x.test", allowed)).toBe(false)
    expect(socketOriginAllowed("https://x.test", undefined, allowed)).toBe(false)
  })
})
