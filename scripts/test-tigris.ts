#!/usr/bin/env npx tsx
/**
 * Test script to verify Tigris storage connection
 * Run with: npx tsx --env-file=.env scripts/test-tigris.ts
 */

import { testConnection, ensureBucketExists, getPresignedUploadUrl, isConfigured } from "../lib/tigris"

async function main() {
  console.log("🔧 Testing Tigris Storage Connection...\n")

  // Check configuration
  console.log("1️⃣ Checking configuration...")
  if (!isConfigured()) {
    console.error("❌ Tigris is not configured. Please check your .env file:")
    console.log("   TIGRIS_ENDPOINT=https://t3.storage.dev")
    console.log("   TIGRIS_ACCESS_KEY=your-access-key")
    console.log("   TIGRIS_SECRET_KEY=your-secret-key")
    console.log("   TIGRIS_BUCKET=blendn-media")
    process.exit(1)
  }
  console.log("✅ Configuration found\n")

  // Test connection
  console.log("2️⃣ Testing connection...")
  const result = await testConnection()
  if (result.success) {
    console.log(`✅ ${result.message}\n`)
  } else {
    console.error(`❌ ${result.message}\n`)
    process.exit(1)
  }

  // Ensure bucket exists
  console.log("3️⃣ Ensuring bucket exists...")
  const bucketReady = await ensureBucketExists()
  if (bucketReady) {
    console.log("✅ Bucket is ready\n")
  } else {
    console.error("❌ Failed to ensure bucket exists\n")
    process.exit(1)
  }

  // Test presigned URL generation
  console.log("4️⃣ Testing presigned URL generation...")
  try {
    const { uploadUrl, publicUrl, key } = await getPresignedUploadUrl(
      "test-image.jpg",
      "image/jpeg",
      "profile",
      "test-user-id"
    )
    console.log("✅ Presigned URL generated successfully!")
    console.log(`   Key: ${key}`)
    console.log(`   Public URL: ${publicUrl}`)
    console.log(`   Upload URL: ${uploadUrl.substring(0, 80)}...`)
  } catch (error) {
    console.error("❌ Failed to generate presigned URL:", error)
    process.exit(1)
  }

  console.log("\n🎉 All tests passed! Tigris storage is ready to use.")
}

main().catch((error) => {
  console.error("Fatal error:", error)
  process.exit(1)
})
