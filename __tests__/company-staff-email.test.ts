import { isStaffEmail } from "@/lib/company"

/** The address rule an admin must pass (SCRUM-1235): the company domain exactly, however it was typed. */
it.each([
  ["someone@matrixsociallabs.com", true],
  [" Someone@MatrixSocialLabs.com ", true],
  ["someone@gmail.com", false],
  ["someone@evil.matrixsociallabs.com", false],
  ["someone@matrixsociallabs.com.evil.com", false],
  ["matrixsociallabs.com@gmail.com", false],
])("%j → %s", (email, staff) => {
  expect(isStaffEmail(email)).toBe(staff)
})
