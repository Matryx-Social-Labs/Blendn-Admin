import { readFileSync } from "fs"
import { join } from "path"

const src = readFileSync(join(__dirname, "..", "app/dashboard/onboarding/queue.tsx"), "utf8")

/**
 * The one-time password outlives the row it came from.
 *
 * `approveOnboardingRequest` revalidates the page, so the approved row leaves
 * the list in the same round trip that produced the credential. Held in the
 * row, it was on screen for zero frames — driven locally with email
 * unconfigured: toast, badge 7 → 6, no password anywhere. The copy promises
 * "shown to you once"; once has to be longer than a re-render.
 */
describe("the approval credential is held by the list, not the row", () => {
  it("the queue owns the state and renders the panel above the rows", () => {
    const queue = src.slice(src.indexOf("export function OnboardingQueue("), src.indexOf("function Row("))
    expect(queue).toMatch(/const \[credential, setCredential\] = useState<Credential \| null>\(null\)/)
    expect(queue).toMatch(/<CredentialPanel credential=\{credential\}/)
    expect(queue).toMatch(/onCredential=\{setCredential\}/)
  })

  it("the row hands it up and keeps none of its own", () => {
    const row = src.slice(src.indexOf("function Row("))
    expect(row).toMatch(/onCredential\(\{ name: row\.display_name, email: result\.email, password: result\.password \}\)/)
    expect(row).not.toMatch(/useState<\{ email: string; password: string \} \| null>/)
    expect(row).not.toMatch(/useState<Credential \| null>/)
  })
})
