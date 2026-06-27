-- Migration: Add goals and looking_for array columns to profiles
-- These were referenced by mobile client types/UI (edit-profile.tsx "Add Goal"/
-- "Add Preference") but never had backing columns, so nothing was ever persisted.

ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "goals" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "looking_for" TEXT[] NOT NULL DEFAULT '{}';
