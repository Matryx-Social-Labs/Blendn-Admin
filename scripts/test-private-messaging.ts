/**
 * Test script for private messaging APIs
 * Run with: npx ts-node scripts/test-private-messaging.ts
 */

const API_BASE = "http://localhost:3000"

interface ApiResponse<T = any> {
  success: boolean
  data?: T
  error?: string
}

async function testPrivateMessaging() {
  console.log("=== Private Messaging API Tests ===\n")

  // First, we need to get a valid token
  // For testing, let's use the login endpoint with a test user

  // Step 1: Try to login or check if we have test users
  console.log("Step 1: Getting authentication token...")

  // Let's try email/password login with a test account
  const loginResponse = await fetch(`${API_BASE}/api/mobile/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "test@example.com",
      password: "testpassword123"
    })
  })

  const loginResult = await loginResponse.json()
  console.log("Login response:", JSON.stringify(loginResult, null, 2))

  if (!loginResult.success || !loginResult.data?.accessToken) {
    console.log("\nNo test user exists. Let's register one...")

    // Register a test user
    const registerResponse = await fetch(`${API_BASE}/api/mobile/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "test@example.com",
        password: "testpassword123",
        name: "Test User 1"
      })
    })

    const registerResult = await registerResponse.json()
    console.log("Register response:", JSON.stringify(registerResult, null, 2))

    if (!registerResult.success) {
      console.error("Failed to register test user")
      return
    }

    // Register a second test user for messaging
    const register2Response = await fetch(`${API_BASE}/api/mobile/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "test2@example.com",
        password: "testpassword123",
        name: "Test User 2"
      })
    })

    const register2Result = await register2Response.json()
    console.log("Register user 2 response:", JSON.stringify(register2Result, null, 2))
  }

  // Now login again to get valid tokens
  const finalLoginResponse = await fetch(`${API_BASE}/api/mobile/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "test@example.com",
      password: "testpassword123"
    })
  })

  const finalLoginResult = await finalLoginResponse.json()

  if (!finalLoginResult.success || !finalLoginResult.data?.accessToken) {
    console.error("Failed to get access token:", finalLoginResult)
    return
  }

  const accessToken = finalLoginResult.data.accessToken
  const userId = finalLoginResult.data.user.id
  console.log(`\n✓ Logged in as user: ${userId}`)

  // Get second user's ID
  const login2Response = await fetch(`${API_BASE}/api/mobile/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "test2@example.com",
      password: "testpassword123"
    })
  })

  const login2Result = await login2Response.json()
  const user2Id = login2Result.data?.user?.id
  const user2Token = login2Result.data?.accessToken

  if (!user2Id) {
    console.error("Failed to get second user")
    return
  }

  console.log(`✓ Second user ID: ${user2Id}\n`)

  // Helper for authenticated requests
  const authFetch = async (url: string, options: RequestInit = {}) => {
    const response = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    })
    return response.json()
  }

  // Step 2: Test creating a conversation
  console.log("Step 2: Creating a conversation with user 2...")
  const createConvoResult = await authFetch(`${API_BASE}/api/mobile/conversations`, {
    method: "POST",
    body: JSON.stringify({ otherUserId: user2Id })
  })
  console.log("Create conversation:", JSON.stringify(createConvoResult, null, 2))

  if (!createConvoResult.success) {
    console.error("Failed to create conversation")
    return
  }

  const conversationId = createConvoResult.data.id
  console.log(`✓ Conversation created: ${conversationId}\n`)

  // Step 3: Test listing conversations
  console.log("Step 3: Listing conversations...")
  const listConvosResult = await authFetch(`${API_BASE}/api/mobile/conversations`)
  console.log("List conversations:", JSON.stringify(listConvosResult, null, 2))
  console.log(`✓ Found ${listConvosResult.data?.length || 0} conversations\n`)

  // Step 4: Test getting a specific conversation
  console.log("Step 4: Getting conversation details...")
  const getConvoResult = await authFetch(`${API_BASE}/api/mobile/conversations/${conversationId}`)
  console.log("Get conversation:", JSON.stringify(getConvoResult, null, 2))
  console.log(`✓ Got conversation with ${getConvoResult.data?.otherUser?.name}\n`)

  // Step 5: Test sending a message
  console.log("Step 5: Sending a message...")
  const sendMsgResult = await authFetch(`${API_BASE}/api/mobile/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ text: "Hello from Test User 1!" })
  })
  console.log("Send message:", JSON.stringify(sendMsgResult, null, 2))

  if (sendMsgResult.success) {
    console.log(`✓ Message sent: ${sendMsgResult.data.id}\n`)
  }

  // Step 6: Test getting messages
  console.log("Step 6: Getting messages...")
  const getMsgsResult = await authFetch(`${API_BASE}/api/mobile/conversations/${conversationId}/messages`)
  console.log("Get messages:", JSON.stringify(getMsgsResult, null, 2))
  console.log(`✓ Got ${getMsgsResult.data?.messages?.length || 0} messages\n`)

  // Step 7: Test as user 2 receiving the message
  console.log("Step 7: User 2 checking messages...")
  const user2MsgsResponse = await fetch(`${API_BASE}/api/mobile/conversations/${conversationId}/messages`, {
    headers: {
      "Authorization": `Bearer ${user2Token}`,
      "Content-Type": "application/json"
    }
  })
  const user2MsgsResult = await user2MsgsResponse.json()
  console.log("User 2 messages:", JSON.stringify(user2MsgsResult, null, 2))

  // Step 8: User 2 sends a reply
  console.log("\nStep 8: User 2 sending a reply...")
  const replyResponse = await fetch(`${API_BASE}/api/mobile/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${user2Token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ text: "Hi there! This is Test User 2 replying." })
  })
  const replyResult = await replyResponse.json()
  console.log("Reply result:", JSON.stringify(replyResult, null, 2))

  // Final: Get all messages again
  console.log("\nStep 9: Final message list...")
  const finalMsgsResult = await authFetch(`${API_BASE}/api/mobile/conversations/${conversationId}/messages`)
  console.log("Final messages:", JSON.stringify(finalMsgsResult, null, 2))

  console.log("\n=== All Tests Complete ===")
  console.log(`Conversation ID: ${conversationId}`)
  console.log(`User 1 ID: ${userId}`)
  console.log(`User 2 ID: ${user2Id}`)
}

testPrivateMessaging().catch(console.error)
