-- Migration: Add User.deletedAt for in-app account deletion

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
