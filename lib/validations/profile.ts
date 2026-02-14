import { z } from "zod"

export const updateProfileSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  phone: z.string().max(20).optional().nullable(),
  age: z.number().int().min(13).max(120).optional().nullable(),
  location: z.string().max(200).optional().nullable(),
  interests: z.array(z.string()).optional(),
  photos: z.array(z.string().url()).max(6).optional(),
  onboarded: z.boolean().optional(),
})

export const addInterestsSchema = z.object({
  categoryIds: z.array(z.string().uuid("Invalid category ID")).min(1, "At least one category is required"),
})

export const removeInterestsSchema = z.object({
  categoryIds: z.array(z.string().uuid("Invalid category ID")).min(1, "At least one category is required"),
})

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>
export type AddInterestsInput = z.infer<typeof addInterestsSchema>
export type RemoveInterestsInput = z.infer<typeof removeInterestsSchema>
