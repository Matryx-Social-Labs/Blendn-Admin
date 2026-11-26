import { identityEmail } from "@/lib/suspended-identity"

describe("identityEmail: one key per inbox", () => {
  it("folds Gmail's dots, +tag and case", () => {
    expect(identityEmail(" A.B+x@Gmail.com ")).toBe("ab@gmail.com")
  })

  it("reads googlemail.com as gmail.com", () => {
    expect(identityEmail("a.b+y@googlemail.com")).toBe("ab@gmail.com")
  })

  it("drops a +tag on any domain, and keeps dots outside Gmail", () => {
    expect(identityEmail("Rhea.Kapoor+again@blendn.app")).toBe("rhea.kapoor@blendn.app")
    expect(identityEmail("a.b@company.com")).toBe("a.b@company.com")
  })

  it("leaves a local part that is only a +tag as typed", () => {
    expect(identityEmail("+x@company.com")).toBe("+x@company.com")
  })
})
