# Blendn App — Legal & Policy Reference Document

> **Purpose:** This document provides a complete technical inventory of the Blendn application for anyone drafting Terms & Conditions, Privacy Policy, Community Guidelines, Cookie Policy, or other legal documents. It covers all data collection, storage, third-party services, user-generated content, and automated systems.
>
> **App Name:** Blendn
> **Company:** Matryx Social Labs
> **Platforms:** iOS, Android (React Native/Expo), Web Admin Dashboard (Next.js)
> **Backend:** Next.js API + Socket.io (real-time), deployed on Railway
> **Last Updated:** 2026-03-25

---

## Table of Contents

1. [App Description & Core Features](#1-app-description--core-features)
2. [Personal Data Collected](#2-personal-data-collected)
3. [Authentication & Account Creation](#3-authentication--account-creation)
4. [Location & Geolocation Data](#4-location--geolocation-data)
5. [Chat System & Anonymity](#5-chat-system--anonymity)
6. [Content Moderation & Automated Decisions](#6-content-moderation--automated-decisions)
7. [File Uploads & Media Storage](#7-file-uploads--media-storage)
8. [Push Notifications](#8-push-notifications)
9. [Device Information](#9-device-information)
10. [Cookies & Session Management](#10-cookies--session-management)
11. [Third-Party Services & Data Sharing](#11-third-party-services--data-sharing)
12. [User-Generated Content](#12-user-generated-content)
13. [Private Messaging & Message Requests](#13-private-messaging--message-requests)
14. [Blocking & Reporting](#14-blocking--reporting)
15. [Data Retention & Deletion](#15-data-retention--deletion)
16. [Rate Limiting & Anti-Abuse](#16-rate-limiting--anti-abuse)
17. [Logging & Audit Trail](#17-logging--audit-trail)
18. [Security Measures](#18-security-measures)
19. [Age & Eligibility](#19-age--eligibility)
20. [Community Guidelines Reference](#20-community-guidelines-reference)
21. [Data Summary Table](#21-data-summary-table)
22. [Third-Party Service Links](#22-third-party-service-links)

---

## 1. App Description & Core Features

Blendn is a **social event discovery and anonymous networking app**. Users can:

- **Discover events** — Browse, search, and RSVP to local events, venues, and hotspots
- **Check in to events** — GPS-verified check-in with configurable radius (default 30m)
- **Anonymous group chat** — Each event has an anonymous chatroom; users get randomly generated names (e.g., "Cosmic Panda", "Neon Falcon") so they can interact without revealing identity
- **Private messaging** — Users can send message requests to connect privately; both parties must consent before a conversation opens
- **User profiles** — Name, bio, occupation, education, interests, photos
- **Event management** — Organisers can create, edit, and manage events with capacity limits, check-in verification, and announcements
- **Ratings & reviews** — Users can rate events (1-5 stars) and leave reviews
- **Content moderation** — Automated AI-powered moderation of chat messages with keyword filtering and OpenAI content analysis
- **Admin dashboard** — Web-based admin panel for event management, chat moderation, user management, announcements, and sponsored messages

---

## 2. Personal Data Collected

### 2a. Data Provided by the User

| Data Type | Required/Optional | Where Used | Storage |
|-----------|-------------------|------------|---------|
| **Email address** | Required | Account creation, login, identification | PostgreSQL database |
| **Name** | Optional | Profile display, social features | PostgreSQL database |
| **Password** | Required (unless OAuth) | Authentication | Stored as bcrypt hash (12 rounds), never in plaintext |
| **Profile photos** | Optional | Profile display (up to multiple photos) | Cloud object storage (Tigris/S3) |
| **Age** | Optional | Profile display | PostgreSQL database |
| **Bio** | Optional | Profile display | PostgreSQL database |
| **Occupation** | Optional | Profile display | PostgreSQL database |
| **Education** | Optional | Profile display | PostgreSQL database |
| **Phone number** | Optional | Profile | PostgreSQL database |
| **Location (text)** | Optional | Profile display, normalised to city name | PostgreSQL database |
| **Interest categories** | Optional | Event recommendations, profile matching | PostgreSQL database |
| **Event ratings & reviews** | Voluntary | Event quality feedback | PostgreSQL database |
| **Chat messages** | Voluntary | Anonymous group chat, private messaging | PostgreSQL database |
| **Event report descriptions** | Voluntary | Safety reporting | PostgreSQL database |

### 2b. Data Collected Automatically

| Data Type | When Collected | Purpose | Storage |
|-----------|----------------|---------|---------|
| **GPS coordinates** (latitude, longitude) | Event check-in/checkout | Verify user is physically at event location | PostgreSQL database (event_check_ins table) |
| **GPS accuracy** (meters) | Event check-in | Validate location precision (max 150m accuracy required) | PostgreSQL database |
| **IP address** | API requests, authentication | Rate limiting, audit logging, abuse prevention | PostgreSQL database (audit_logs table) |
| **Device info** (platform, model, app version) | Token refresh, check-in | Device identification, debugging | PostgreSQL database (JSON field) |
| **Push notification token** | Notification opt-in | Delivering push notifications | PostgreSQL database |
| **Timestamps** | All actions | Record creation/update tracking | PostgreSQL database |

### 2c. Data from Third Parties

| Data Type | Source | When Collected | Purpose |
|-----------|--------|----------------|---------|
| **Google profile** (name, email, profile picture) | Google OAuth | Google sign-in | Account creation, profile pre-fill |
| **Google user ID** (`sub`) | Google OAuth | Google sign-in | Account linking |
| **Email verification status** | Google OAuth | Google sign-in | Security verification |
| **City name from coordinates** | OpenStreetMap Nominatim | Profile location update, event creation | Convert GPS to human-readable location |

---

## 3. Authentication & Account Creation

### Methods of Account Creation
1. **Email + Password** — User provides email and password; password stored as bcrypt hash
2. **Google OAuth** — User authenticates via Google; email and profile data retrieved from Google
3. **Apple Sign-In** — Supported via OAuth account linking (provider field supports "apple")

### Token Management
- **Mobile access tokens:** JWT, 15-minute expiry
- **Mobile refresh tokens:** 30-day expiry, stored as bcrypt hashes in database
  - Includes device information for identification
  - Can be individually revoked (e.g., logout from specific device)
  - Bulk revocation on password change or security events
- **Web dashboard sessions:** NextAuth.js JWT-based sessions

### Account Deletion
- Users can request account deletion (implementation pending — this should be documented in privacy policy as a user right)
- Soft-delete pattern used for most data
- Connected OAuth accounts stored in `user_oauth_accounts` table

---

## 4. Location & Geolocation Data

### When Location is Collected
- **Event check-in:** GPS coordinates required to verify user is within the event's check-in radius
- **Profile location:** Optional text field, auto-normalised to city name via reverse geocoding
- **Event creation:** Organisers set event location with coordinates and address

### How Location is Used
- **Proximity verification:** Haversine distance calculation ensures user is within configurable radius (default 30m) of event
- **Reverse geocoding:** GPS coordinates converted to city name using OpenStreetMap Nominatim API
- **Event discovery:** Events shown based on city/location

### Location Data Stored
- **event_check_ins:** latitude, longitude (precise GPS at time of check-in)
- **events:** latitude, longitude, address, venue_name, city, state, country, postal_code
- **profiles:** location (city name string only, not raw coordinates)

### Location Accuracy Requirements
- GPS accuracy must be within 150 meters (configurable per event)
- Check-ins rejected if GPS accuracy is too poor

### Important for Privacy Policy
- Location is collected **only during active check-in**, not continuously tracked
- Coordinates are stored as point-in-time snapshots, not ongoing tracking
- Background location tracking is NOT used
- Users must actively initiate check-in to share location

---

## 5. Chat System & Anonymity

### Anonymous Group Chat
- Each event creates one anonymous chatroom on first check-in
- Users are assigned **randomly generated anonymous names** (e.g., "Cosmic Panda", "Neon Falcon")
- Anonymous names are unique within each chat group
- **Real identity is NOT revealed** to other chat participants
- User profile photos are NOT shown in chat (set to null in responses)
- Real user IDs are stored internally for moderation purposes but not exposed to other users

### Chat Access Rules
- Must be checked in to an event to send messages
- After checkout, users can view historical messages up to their checkout time but cannot send new ones
- Chat can be locked by organisers (prevents all new messages)

### Message Types Supported
- Text (max 4,000 characters)
- Images (JPEG, PNG, WebP, GIF — max 50MB)
- Videos (MP4, QuickTime — max 50MB)
- Audio (MP3, M4A — max 50MB)
- System messages (automated announcements)
- Sponsored messages (organiser-configured, auto-sent at intervals)
- Announcements (organiser-only, push-notified to all members)

### Thread/Reply Support
- Messages support parent-child threading via `parent_id`
- Reply count tracked per message

### Reactions
- Emoji reactions on messages
- Tracked per user (one reaction type per user per message)

---

## 6. Content Moderation & Automated Decisions

### Overview
All chat messages pass through an **automated multi-layer moderation pipeline** that runs asynchronously after the message is sent and displayed. This is important for transparency disclosures.

### Moderation Layers

#### Layer 1: Keyword Filter (Instant, <1ms)
- Scans messages against a curated list of slurs, profanity, and hate speech terms
- Supports multiple languages:
  - **English** — racial slurs, profanity, hate terms
  - **Hindi** — Devanagari script + transliterated Latin script (e.g., "madarchod", "behenchod")
  - **South Indian languages** — Tamil, Telugu, Kannada, Malayalam
  - **Other Indian languages** — Bengali, Marathi, Gujarati
- Includes leetspeak normalisation (e.g., "n1gg3r" → "nigger")
- Includes abbreviation detection (e.g., "mc", "bc", "bsdk")
- **Confidence scoring:** Single keyword match = 0.85+ confidence → auto-hide

#### Layer 2: AI Text Moderation (50-200ms)
- Uses **OpenAI Moderation API** (`omni-moderation-latest` model)
- Categories analysed:
  - Hate speech & threatening hate speech
  - Harassment & threatening harassment
  - Self-harm, self-harm intent, self-harm instructions
  - Sexual content & sexual content involving minors
  - Violence & graphic violence
- **Auto-hide threshold:** 0.7 confidence
- **Flag for review threshold:** 0.4 confidence

#### Layer 3: AI Image Moderation (500-1500ms)
- Scans uploaded images/GIFs through OpenAI Moderation API
- Same categories and thresholds as text moderation

#### Layer 4: Spam Detection (Instant)
- **Burst rate detection:** 5+ messages in 10 seconds
- **Duplicate content detection:** >80% similarity (trigram-based)
- **Link density detection:** >2 links per message

### Automated Actions Taken
| Action | Trigger | What Happens |
|--------|---------|--------------|
| **Auto-hide** | Confidence ≥ 0.7 | Message hidden from all users; sender sees "This message was removed" placeholder |
| **Flag for review** | Confidence 0.4–0.7 | Message visible but flagged for admin review |
| **Auto-mute** | 3+ hidden messages in 1 hour | User muted from chat; can read but not send |
| **Spam block** | Rate/duplicate/link threshold exceeded | Message rejected with error code |

### Human Review
- Flagged messages appear in the admin dashboard for human review
- Admins can approve (false positive) or reject (confirm violation)
- Admins can manually ban or mute users from the dashboard
- Admin actions tracked with `reviewed_by`, `reviewed_at`, `review_notes`

### Important for Terms & Community Guidelines
- Users should be informed that **all chat messages are subject to automated content analysis**
- Messages may be **automatically removed** if they violate content policies
- The system uses **AI-based analysis** which may occasionally produce false positives
- Users who repeatedly violate policies will be **automatically muted**
- Admins can **ban users** from chat permanently
- **Message content is stored** even after hiding, for moderation review purposes

---

## 7. File Uploads & Media Storage

### Storage Provider
- **Tigris** (S3-compatible object storage, hosted on Railway infrastructure)
- Bucket: `blendn-media`
- Region: auto (Tigris global CDN)
- Files are publicly accessible via CDN URL after upload

### Upload Categories & Limits

| Category | Max File Size | Allowed Types | Purpose |
|----------|---------------|---------------|---------|
| **Profile photos** | 10 MB | JPEG, PNG, WebP, GIF | User profile pictures |
| **Chat media** | 50 MB | JPEG, PNG, WebP, GIF, MP4, QuickTime, MP3, M4A | In-chat media sharing |
| **Event images** | 20 MB | JPEG, PNG, WebP | Event cover images and gallery |

### Upload Process
- Client requests a **presigned upload URL** (valid for 15 minutes)
- Client uploads directly to cloud storage using the presigned URL
- Server never handles the file bytes directly
- File path format: `{folder}/{userId}/{timestamp}-{random}-{filename}`
- Metadata attached: `uploaded-by` (user ID), `original-filename`

### Deletion
- Users can delete their own uploads
- Ownership verified before deletion (only the uploader can delete)
- Hard delete from storage (file permanently removed)
- Admins can delete any upload

### Important for Privacy Policy
- Uploaded media is stored on third-party cloud infrastructure
- Files are publicly accessible via CDN URL (no additional authentication required to view)
- Users should be warned that shared media in chat is accessible to all chat participants
- Deleted files are permanently removed from storage

---

## 8. Push Notifications

### Service Provider
- **Expo Push Notification Service** (acts as intermediary to APNs and FCM)

### Data Stored
- Push notification token (device-specific)
- Platform (iOS or Android)
- Up to 5 tokens per user (most recent devices)

### Notification Types Sent

| Type | Content | When Sent |
|------|---------|-----------|
| **Private message** | Sender name + message preview (truncated 100 chars) | New private message received |
| **Group message** | Anonymous name + message preview (truncated 80 chars) | New message in event chat |
| **Event check-in** | "[Name] checked in to [Event]" | Someone checks into an event |
| **Event update** | Event title + update details | Organiser updates event |
| **Announcement** | Announcement content preview | Organiser sends announcement |
| **Message request** | "[Name] wants to connect" | New message request received |
| **Message request response** | "[Name] accepted your request" | Request accepted/declined |

### Notification Channels (Android)
- `messages` — Chat and private messages
- `announcements` — Event announcements
- `default` — General notifications

### Token Lifecycle
- Registered when user enables notifications
- Unregistered on logout or user request
- Auto-cleaned when Expo reports `DeviceNotRegistered`

### Important for Privacy Policy
- Push tokens are shared with Expo's notification service
- Message previews are included in notification payloads (visible on lock screen)
- Users can unregister tokens to stop receiving notifications

---

## 9. Device Information

### What is Collected
- **Platform** (iOS / Android)
- **Device name/model** (e.g., "iPhone 15", "Pixel 8")
- **App version**
- **GPS accuracy** (meters, during check-in)

### Where it's Stored
- `mobile_refresh_tokens.device_info` — JSON field, stored with each refresh token
- `event_check_ins.device_info` — JSON field, stored with each check-in record

### Purpose
- **Device identification:** Know which devices are signed in
- **Debugging:** Diagnose platform-specific issues
- **Security:** Detect unusual device changes on account
- **Location quality:** Validate GPS accuracy for check-in verification

---

## 10. Cookies & Session Management

### Web Dashboard (Admin Panel)
- **NextAuth.js session cookie** — Encrypted JWT stored in HTTP-only cookie
- **Session strategy:** JWT (no server-side session storage)
- **Token payload:** User ID, user role, issued-at, expiry
- **Cookie security:** HTTP-only, Secure (HTTPS), SameSite

### Mobile App
- **No cookies used** — Authentication via Bearer token in HTTP headers
- Access token (JWT) stored in device secure storage
- Refresh token stored in device secure storage

### Important for Cookie Policy
- The web admin dashboard uses a **single essential session cookie** for authentication
- No marketing, analytics, or tracking cookies are used on the web dashboard
- The mobile app does not use cookies at all

---

## 11. Third-Party Services & Data Sharing

### Services Used

| Service | Data Shared | Purpose | Data Processing Location |
|---------|-------------|---------|--------------------------|
| **Google OAuth** | Email, name, profile picture, Google user ID | Account authentication | Google servers (global) |
| **OpenAI Moderation API** | Chat message text content, image URLs | Automated content moderation | OpenAI servers (US) |
| **Expo Push Notifications** | Push tokens, notification payloads (message previews) | Delivering push notifications to iOS/Android | Expo servers (US) |
| **Tigris (S3-compatible)** | Uploaded files (photos, media) | Cloud file storage | Tigris CDN (global, Railway infrastructure) |
| **OpenStreetMap Nominatim** | GPS coordinates (latitude, longitude) | Reverse geocoding (coordinates → city name) | OpenStreetMap servers |
| **Railway** | Application code, database, environment variables | Cloud hosting & deployment | Railway infrastructure (US) |
| **Sentry** (optional) | Error reports, stack traces (may include user context) | Error tracking & monitoring | Sentry servers (US) |

### Important for Privacy Policy
- **OpenAI receives all chat message content** for moderation analysis
- **Expo receives push notification payloads** which include message previews
- **OpenStreetMap receives GPS coordinates** for geocoding
- **Tigris/S3 stores all user-uploaded media** as publicly accessible files
- No data is sold to third parties
- Data sharing is limited to operational necessity

---

## 12. User-Generated Content

### Types of Content Users Create

| Content Type | Ownership | Visibility | Moderation |
|--------------|-----------|------------|------------|
| **Profile information** | User-owned | Visible to other users (name, bio, photos) | Manual review by admins |
| **Chat messages** | User-authored, platform-hosted | Visible to event chat participants (anonymous) | Automated AI + keyword filter + admin review |
| **Private messages** | User-authored | Visible only to conversation participants | Not currently moderated |
| **Event ratings & reviews** | User-authored | Public (visible on event page) | Manual review by admins |
| **Event reports** | User-authored | Visible only to admins | N/A |
| **Uploaded media** | User-uploaded | Depends on context (chat, profile, event) | Image moderation via OpenAI for chat |

### Content Licensing (for Terms & Conditions)
- The T&C should specify that users grant the platform a licence to host, display, and distribute their content
- Anonymous chat messages should be noted as being displayed under pseudonymous names
- The platform reserves the right to remove content that violates community guidelines
- Users retain ownership of their original content

---

## 13. Private Messaging & Message Requests

### How Private Messaging Works
1. **User A sends a message request** to User B (optional introductory message, max 500 chars)
2. **User B reviews** and accepts or declines the request
3. **If accepted**, a private conversation is created between the two users
4. Both users can then exchange messages freely

### Consent Model
- **Double opt-in:** Both parties must agree before private messaging begins
- Users cannot be messaged without accepting a request first
- Blocked users cannot send message requests (returns generic "User not found" to prevent information leakage)

### Private Message Features
- Text messages (max 5,000 characters)
- Image and video attachments
- Read receipts (is_read flag)
- Typing indicators (real-time via Socket.io)

### Important for Privacy Policy
- Private messages are stored unencrypted in the database (not end-to-end encrypted)
- Platform administrators can technically access private messages
- Private messages are NOT currently subject to automated moderation (this should be noted)
- Message request status (pending/accepted/declined/blocked) is tracked

---

## 14. Blocking & Reporting

### User Blocking
- Any user can block any other user
- **Effects of blocking:**
  - Blocked user cannot send private messages to blocker
  - Blocked user cannot send message requests to blocker
  - Block status is not revealed to the blocked user (generic errors returned)
- Blocking is one-directional (A blocks B ≠ B blocks A)
- Users can unblock at any time

### Event Reporting
- Users can report events with a reason and description
- Reports stored with status: pending → reviewed → resolved
- Admin dashboard shows reports for review

### Chat Moderation Actions (Admin)
- **Mute:** User can read chat but cannot send messages
- **Ban:** User fully removed from chat
- **Unmute/Unban:** Restore access

---

## 15. Data Retention & Deletion

### Retention Periods

| Data Type | Retention | Deletion Method |
|-----------|-----------|-----------------|
| **User account** | Until deletion requested | Soft delete (deleted_at timestamp) |
| **Chat messages** | Indefinite | Soft delete; moderation-hidden messages retained for review |
| **Private messages** | Until conversation deleted | Hard delete (cascade) |
| **Event check-ins** (incl. GPS) | Indefinite | Retained for event analytics |
| **Moderation flags** | Indefinite | Retained for violation history and auto-mute calculations |
| **Audit logs** (incl. IP addresses) | Indefinite | Retained for security investigations |
| **Refresh tokens** | 30 days after issuance | Periodic cleanup deletes expired/revoked tokens |
| **Push tokens** | Until logout or device unregistered | Hard delete on unregister or invalid token detection |
| **Uploaded files** | Until user deletes or admin removes | Hard delete from cloud storage |
| **Event data** | Indefinite (soft delete for cancelled) | Soft delete |
| **Blocked user records** | Until user unblocks | Hard delete |
| **Event favourites/RSVPs** | Until user removes | Hard delete |

### Important for Privacy Policy
- Most data uses **soft deletion** (marked as deleted but retained in database)
- Moderation records and audit logs are **not deleted** even when the related content is
- Users should be informed of their right to request full data deletion (GDPR/CCPA if applicable)
- IP addresses are stored in audit logs indefinitely
- GPS coordinates from check-ins are stored indefinitely

---

## 16. Rate Limiting & Anti-Abuse

### Rate Limits Applied

| Action | Limit | Window | Identifier |
|--------|-------|--------|------------|
| Sign-in attempts | 5 | 15 minutes | IP address |
| Sign-up attempts | 3 | 1 hour | IP address |
| Google auth attempts | 10 | 15 minutes | IP address |
| Token refresh | 20 | 15 minutes | IP address |
| Chat messages | 30 | 1 minute | User ID + Chat Group |
| Event check-ins | 10 | 10 minutes | User ID |
| Batch API requests | 30 | 1 minute | User ID |

### Anti-Spam Measures
- Burst detection: 5+ messages in 10 seconds
- Duplicate detection: >80% text similarity between recent messages
- Link density: >2 links per message blocked
- Auto-mute after 3 moderation violations in 1 hour

---

## 17. Logging & Audit Trail

### What is Logged

| Log Type | Data Included | Purpose |
|----------|---------------|---------|
| **Audit logs** | User ID, action, resource, resource ID, details (JSON), IP address, timestamp | Security, compliance, abuse investigation |
| **Application logs** | Structured JSON with log level, message, context | Debugging, monitoring |
| **Error tracking** (Sentry) | Stack traces, error context, potentially user ID | Bug diagnosis |

### Audit Log Actions Tracked
- Authentication events (sign-in, sign-up, logout, token refresh)
- User profile updates
- Messaging actions
- Event operations (create, update, delete)
- Moderation actions (auto-hide, flag, mute, ban)
- Admin actions (review, approve, reject)

### Important for Privacy Policy
- User actions are logged with IP addresses
- Logs may be used for security investigations
- Sentry (if enabled) receives error data that may include user context
- Log retention is indefinite (no automatic purge)

---

## 18. Security Measures

### Data Protection
- **Passwords:** Bcrypt hashed with 12 salt rounds (never stored in plaintext)
- **Refresh tokens:** Stored as bcrypt hashes in database
- **JWT tokens:** Signed with secret keys, short-lived (15-minute access tokens)
- **File uploads:** Presigned URLs (15-minute validity), direct-to-storage upload

### Transport Security
- **HTTPS only** — All API endpoints served over TLS
- **CORS restricted** — Only allowed origins: api.blendn.app, blendn.app
- **Security headers:**
  - X-Frame-Options: DENY (prevents clickjacking)
  - X-Content-Type-Options: nosniff
  - Referrer-Policy: strict-origin-when-cross-origin

### Access Control
- **Role-based access:** app_admin, organizer, venue_owner, attendee
- **Route protection:** Middleware validates JWT/session before API access
- **Resource ownership:** Users can only modify their own resources (profiles, uploads, etc.)

---

## 19. Age & Eligibility

### Current Implementation
- **No explicit age verification** is implemented in the current codebase
- User `age` field is optional and self-reported
- No age gates or date-of-birth collection at sign-up

### Recommendations for Terms & Conditions
- Define minimum age requirement (typically 13+ for COPPA compliance, 16+ for GDPR)
- State that the service is not intended for children under the minimum age
- If targeting events with age restrictions (bars, clubs), note that event organisers are responsible for enforcing age limits at physical venues
- Consider adding a date-of-birth field at sign-up for age verification

---

## 20. Community Guidelines Reference

### Behaviours the Moderation System Detects & Prohibits

Based on the automated moderation system, the following should be explicitly prohibited in Community Guidelines:

#### Hate Speech & Discrimination
- Racial slurs (English + multiple Indian languages)
- Ethnic slurs and derogatory terms
- Casteist slurs (Indian languages)
- Religious hate speech
- Gender-based slurs
- Homophobic/transphobic slurs
- Attempts to evade filters (leetspeak: "n1gg3r", abbreviations: "mc", "bc")

#### Harassment & Threats
- Threatening language directed at individuals or groups
- Bullying or targeted harassment
- Doxxing or sharing personal information

#### Sexual Content
- Sexually explicit messages or media
- Sexual content involving minors (zero tolerance)
- Unsolicited sexual advances

#### Violence
- Graphic violence descriptions
- Threats of violence
- Gore or disturbing imagery

#### Self-Harm
- Content promoting or glorifying self-harm
- Suicide instructions or encouragement

#### Spam & Abuse
- Rapid message flooding (5+ messages in 10 seconds)
- Duplicate/repetitive messages
- Excessive link sharing (3+ links per message)
- Advertising or promotional spam

#### Consequences for Violations
1. **First offence:** Message automatically removed; user sees "This message was removed" notification
2. **Repeated offences (3+ in 1 hour):** Automatic mute — user can read but not send messages
3. **Severe/persistent violations:** Admin ban from chat (permanent removal)
4. **Account-level action:** Admins can suspend or terminate accounts for severe violations

### Guidelines for Anonymous Chat Specifically
- Anonymity does not exempt users from community guidelines
- Anonymous names are system-generated; impersonation of system roles is prohibited
- Real identity discovery or deanonymisation attempts are prohibited
- Anonymous chat is a privilege that can be revoked

---

## 21. Data Summary Table

| Category | Data Points | Shared With | Retention |
|----------|-------------|-------------|-----------|
| **Identity** | Email, name, password hash, Google ID | Google (OAuth only) | Until account deletion |
| **Profile** | Age, bio, occupation, education, phone, photos, interests | Visible to other users | Until account deletion |
| **Location** | GPS coordinates, city, address | OpenStreetMap (geocoding only) | Indefinite |
| **Chat Messages** | Text content, media URLs, timestamps, anonymous names | OpenAI (moderation), other chat participants (anonymised) | Indefinite (soft delete) |
| **Private Messages** | Text content, media URLs, read status | Conversation participants only | Until conversation deleted |
| **Device Info** | Platform, model, app version, GPS accuracy | Not shared externally | With associated records |
| **Push Tokens** | Expo push token, platform | Expo Push Service | Until unregistered |
| **Files** | Photos, images, videos, audio | Tigris/S3 CDN (publicly accessible URLs) | Until user/admin deletes |
| **Activity** | Check-ins, RSVPs, favourites, ratings, blocks | Not shared externally | Indefinite |
| **Audit Data** | IP addresses, actions, timestamps | Sentry (errors only, if enabled) | Indefinite |

---

## 22. Third-Party Service Links

Include links to these third-party privacy policies in the app's Privacy Policy:

| Service | Privacy Policy URL | Data They Receive |
|---------|--------------------|-------------------|
| **Google** (OAuth) | https://policies.google.com/privacy | Authentication tokens, user profile |
| **OpenAI** (Moderation API) | https://openai.com/policies/privacy-policy | Chat message text and image URLs |
| **Expo** (Push Notifications) | https://expo.dev/privacy | Push tokens, notification content |
| **Tigris/Fly.io** (Object Storage) | https://fly.io/legal/privacy-policy | Uploaded files |
| **OpenStreetMap** (Geocoding) | https://wiki.osmfoundation.org/wiki/Privacy_Policy | GPS coordinates |
| **Railway** (Hosting) | https://railway.app/legal/privacy | Application data, database |
| **Sentry** (Error Tracking) | https://sentry.io/privacy | Error reports, stack traces |

---

## Notes for Legal Document Drafters

1. **Jurisdiction:** Determine the applicable jurisdiction(s) and which privacy regulations apply (GDPR, CCPA, India's DPDP Act 2023, etc.)
2. **Data Controller:** Matryx Social Labs is the data controller for all user data
3. **Anonymity disclosure:** The anonymous chat feature uses pseudonyms, but the platform retains the real user identity internally — this should be clearly disclosed
4. **AI disclosure:** Automated content moderation using AI (OpenAI) should be disclosed, including the possibility of false positives and the user's right to appeal (admin review)
5. **No encryption at rest:** Private messages and chat messages are not end-to-end encrypted — the platform can access message content for moderation and legal compliance
6. **Public files:** Uploaded media is stored with publicly accessible URLs — once shared in chat, other participants can access the direct URL
7. **Cross-border data transfer:** Data is processed on US-based servers (Railway, OpenAI, Expo) — relevant for GDPR/international users
8. **No COPPA compliance currently:** No age verification is implemented; this needs to be addressed in terms or by implementing age gates
9. **Indian language moderation:** The keyword filter covers Hindi, Tamil, Telugu, Kannada, Malayalam, Bengali, Marathi, and Gujarati — community guidelines should note multi-language enforcement
10. **Sponsored messages:** Organisers can send sponsored/promoted messages to event chats at configured intervals — users should be informed that some chat content is promotional
