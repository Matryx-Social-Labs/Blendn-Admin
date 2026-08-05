import { redirect } from "next/navigation"

import { getAuth } from "@/lib/auth"
import { getCategories } from "@/lib/category-actions"

import { CategoryManager } from "./manager"

export const dynamic = "force-dynamic"

/**
 * The category taxonomy.
 *
 * Categories were created by `scripts/seed-categories.ts` and by nothing else —
 * an admin could not fix a typo, retire a dead category, or merge the two that
 * always end up meaning the same thing.
 */
export default async function CategoriesPage() {
  const session = await getAuth()
  if (!session?.user) redirect("/login")
  if (session.user.role !== "app_admin") redirect("/dashboard")

  return <CategoryManager categories={await getCategories()} />
}
