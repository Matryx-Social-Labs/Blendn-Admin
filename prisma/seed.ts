import { PrismaClient } from "@prisma/client"
import bcrypt from "bcryptjs"

const prisma = new PrismaClient()

async function main() {
  const hashedPassword = await bcrypt.hash("Matrix@2025", 12)

  const user = await prisma.user.upsert({
    where: { email: "contact@matrixsociallabs.com" },
    update: {},
    create: {
      email: "contact@matrixsociallabs.com",
      name: "Admin",
      password: hashedPassword,
    },
  })

  console.log("Created user:", user.email)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
