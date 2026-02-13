# OMGTV Notification Service — API Documentation

**Base URL:** `https://<your-domain>` (Port `4700` internally)
**Health Check:** `GET /health`

---

## Table of Contents

- [For Mobile App Developers](#for-mobile-app-developers)
  - [FCM Token Management](#1-fcm-token-management)
  - [Notifications](#2-notifications)
  - [User Preferences](#3-user-preferences)
- [For Admin / Dashboard Developers](#for-admin--dashboard-developers)
  - [Send Targeted Notification](#4-send-targeted-notification)
  - [Broadcast Notification](#5-broadcast-notification)
  - [Notification Statistics](#6-notification-statistics)
  - [Campaigns](#7-campaigns)
- [Internal / Inter-Service (gRPC)](#internal--inter-service-grpc)
- [Data Models Reference](#data-models-reference)

---

# For Mobile App Developers

> **Authentication:** All requests require the header `x-user-id: <UUID>` (injected by API Gateway after auth).

---

## 1. FCM Token Management

### Register FCM Token

Register a device's Firebase Cloud Messaging token for push notifications.

```
POST /api/v1/notifications/push/register-token
```

| Field      | Type                        | Required | Description              |
| ---------- | --------------------------- | -------- | ------------------------ |
| `userId`   | string (UUID)               | ✅       | User ID                  |
| `token`    | string                      | ✅       | FCM device token         |
| `deviceId` | string                      | ❌       | Unique device identifier |
| `platform` | `ios` \| `android` \| `web` | ❌       | Device platform          |

```bash
curl -X POST https://<domain>/api/v1/notifications/push/register-token \
  -H "Content-Type: application/json" \
  -H "x-user-id: <USER_UUID>" \
  -d '{
    "userId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "token": "fMC_token_from_firebase_sdk",
    "deviceId": "device-abc123",
    "platform": "android"
  }'
```

**Response:**

```json
{ "success": true, "tokenId": "token-uuid" }
```

---

### Unregister FCM Token

Call on logout or when token is invalidated.

```
DELETE /api/v1/notifications/push/unregister-token
```

```bash
curl -X DELETE https://<domain>/api/v1/notifications/push/unregister-token \
  -H "Content-Type: application/json" \
  -d '{ "token": "fMC_token_from_firebase_sdk" }'
```

**Response:**

```json
{ "success": true }
```

---

## 2. Notifications

### Get User Notifications

Fetch paginated in-app notifications for the current user.

```
GET /api/v1/notifications?limit=20&offset=0
```

| Param    | Type   | Default | Description       |
| -------- | ------ | ------- | ----------------- |
| `limit`  | number | 20      | Items per page    |
| `offset` | number | 0       | Pagination offset |

```bash
curl -X GET "https://<domain>/api/v1/notifications?limit=10&offset=0" \
  -H "x-user-id: <USER_UUID>"
```

**Response:**

```json
{
  "notifications": [
    {
      "id": "uuid",
      "userId": "user-uuid",
      "type": "IN_APP",
      "title": "New Content Available",
      "body": "Check out the latest episode!",
      "data": {},
      "status": "SENT",
      "priority": "MEDIUM",
      "createdAt": "2026-02-13T12:00:00.000Z"
    }
  ]
}
```

---

### Mark Notification as Read

```
PATCH /api/v1/notifications/:id/read
```

```bash
curl -X PATCH https://<domain>/api/v1/notifications/<NOTIFICATION_ID>/read \
  -H "x-user-id: <USER_UUID>"
```

---

### Mark All Notifications as Read

```
PATCH /api/v1/notifications/read-all
```

```bash
curl -X PATCH https://<domain>/api/v1/notifications/read-all \
  -H "x-user-id: <USER_UUID>"
```

**Response:**

```json
{ "success": true, "count": 5 }
```

---

### Get Unread Count

```
GET /api/v1/notifications/unread-count
```

```bash
curl -X GET https://<domain>/api/v1/notifications/unread-count \
  -H "x-user-id: <USER_UUID>"
```

**Response:**

```json
{ "count": 3 }
```

---

### Delete Notification

```
DELETE /api/v1/notifications/:id
```

```bash
curl -X DELETE https://<domain>/api/v1/notifications/<NOTIFICATION_ID> \
  -H "x-user-id: <USER_UUID>"
```

---

## 3. User Preferences

### Get Notification Preferences

```
GET /api/v1/preferences
```

```bash
curl -X GET https://<domain>/api/v1/preferences \
  -H "x-user-id: <USER_UUID>"
```

**Response:**

```json
{
  "userId": "user-uuid",
  "emailEnabled": true,
  "pushEnabled": true,
  "inAppEnabled": true,
  "allowMarketing": true,
  "allowTransactional": true,
  "allowNewContent": true
}
```

---

### Update Notification Preferences

```
PATCH /api/v1/preferences
```

All fields are optional — send only what changed.

```bash
curl -X PATCH https://<domain>/api/v1/preferences \
  -H "Content-Type: application/json" \
  -H "x-user-id: <USER_UUID>" \
  -d '{
    "pushEnabled": false,
    "allowMarketing": false
  }'
```

---

# For Admin / Dashboard Developers

> **Authentication:** Admin routes require both `x-user-id` and `x-user-role: admin` headers.

---

## 4. Send Targeted Notification

Send a notification to a specific user by ID.

```
POST /api/v1/admin/notifications/send
```

| Field      | Type                                      | Required | Description          |
| ---------- | ----------------------------------------- | -------- | -------------------- |
| `userId`   | string (UUID)                             | ✅       | Target user          |
| `title`    | string (1–100)                            | ✅       | Notification title   |
| `body`     | string (1–500)                            | ✅       | Notification body    |
| `type`     | `EMAIL` \| `PUSH` \| `IN_APP`             | ❌       | Default: `IN_APP`    |
| `priority` | `LOW` \| `MEDIUM` \| `HIGH` \| `CRITICAL` | ❌       | Default: `MEDIUM`    |
| `data`     | object                                    | ❌       | Extra key-value data |

```bash
curl -X POST https://<domain>/api/v1/admin/notifications/send \
  -H "Content-Type: application/json" \
  -H "x-user-id: <ADMIN_UUID>" \
  -H "x-user-role: admin" \
  -d '{
    "userId": "target-user-uuid",
    "title": "Account Update",
    "body": "Your subscription has been upgraded!",
    "type": "PUSH",
    "priority": "HIGH"
  }'
```

**Response:**

```json
{ "success": true, "notificationId": "notif-uuid" }
```

---

## 5. Broadcast Notification

Send a push notification to **all users** via FCM topic `all-users`.

```
POST /api/v1/admin/notifications/broadcast
```

| Field      | Type                                      | Required | Description          |
| ---------- | ----------------------------------------- | -------- | -------------------- |
| `title`    | string (1–100)                            | ✅       | Notification title   |
| `body`     | string (1–500)                            | ✅       | Notification body    |
| `priority` | `LOW` \| `MEDIUM` \| `HIGH` \| `CRITICAL` | ❌       | Default: `MEDIUM`    |
| `data`     | object                                    | ❌       | Extra key-value data |

```bash
curl -X POST https://<domain>/api/v1/admin/notifications/broadcast \
  -H "Content-Type: application/json" \
  -H "x-user-id: <ADMIN_UUID>" \
  -H "x-user-role: admin" \
  -d '{
    "title": "🎉 New Feature Launch!",
    "body": "Check out our exciting new content library.",
    "priority": "HIGH"
  }'
```

---

## 6. Notification Statistics

```
GET /api/v1/admin/notifications/stats
```

```bash
curl -X GET https://<domain>/api/v1/admin/notifications/stats \
  -H "x-user-id: <ADMIN_UUID>" \
  -H "x-user-role: admin"
```

**Response:**

```json
{
  "total": 1500,
  "pending": 12,
  "sent": 1400,
  "failed": 8,
  "read": 980
}
```

---

## 7. Campaigns

### Create Campaign

```
POST /api/v1/admin/campaigns
```

| Field            | Type                          | Required | Description                         |
| ---------------- | ----------------------------- | -------- | ----------------------------------- |
| `name`           | string (1–100)                | ✅       | Campaign name                       |
| `title`          | string (1–100)                | ✅       | Notification title                  |
| `body`           | string (1–500)                | ✅       | Notification body                   |
| `type`           | `PUSH` \| `EMAIL` \| `IN_APP` | ✅       | Channel                             |
| `data`           | object                        | ❌       | Extra payload                       |
| `targetCriteria` | object                        | ❌       | Targeting rules                     |
| `idempotencyKey` | string                        | ❌       | Dedup key                           |
| `scheduledAt`    | ISO 8601 datetime             | ❌       | Schedule for later (omit for draft) |

```bash
curl -X POST https://<domain>/api/v1/admin/campaigns \
  -H "Content-Type: application/json" \
  -H "x-user-id: <ADMIN_UUID>" \
  -H "x-user-role: admin" \
  -d '{
    "name": "Weekend Promo",
    "title": "50% Off This Weekend!",
    "body": "Use code WEEKEND50 for all premium content.",
    "type": "PUSH",
    "scheduledAt": "2026-02-15T10:00:00.000Z",
    "idempotencyKey": "weekend-promo-feb-2026"
  }'
```

### List Campaigns

```
GET /api/v1/admin/campaigns?limit=10&offset=0
```

```bash
curl -X GET "https://<domain>/api/v1/admin/campaigns?limit=10&offset=0" \
  -H "x-user-id: <ADMIN_UUID>" \
  -H "x-user-role: admin"
```

### Get Campaign Details

```
GET /api/v1/admin/campaigns/:id
```

```bash
curl -X GET https://<domain>/api/v1/admin/campaigns/<CAMPAIGN_ID> \
  -H "x-user-id: <ADMIN_UUID>" \
  -H "x-user-role: admin"
```

### Execute Campaign

Manually trigger a campaign to send immediately.

```
POST /api/v1/admin/campaigns/:id/execute
```

```bash
curl -X POST https://<domain>/api/v1/admin/campaigns/<CAMPAIGN_ID>/execute \
  -H "Content-Type: application/json" \
  -H "x-user-id: <ADMIN_UUID>" \
  -H "x-user-role: admin" \
  -d '{ "idempotencyKey": "exec-weekend-promo-1" }'
```

---

# Internal / Inter-Service (gRPC)

> **Port:** `50072` | **Proto:** `proto/notification.proto`

Other microservices (e.g., AuthService, ContentService) can call the Notification Service over gRPC.

### SendNotification

| Field         | Type   | Description                         |
| ------------- | ------ | ----------------------------------- |
| `userId`      | string | Target user UUID                    |
| `type`        | string | `EMAIL`, `PUSH`, or `IN_APP`        |
| `title`       | string | Notification title                  |
| `body`        | string | Notification body                   |
| `payloadJson` | string | JSON string with extra data         |
| `priority`    | string | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` |

**Response:** `{ success, notificationId, error }`

### UpdatePreferences

| Field          | Type   | Description           |
| -------------- | ------ | --------------------- |
| `userId`       | string | Target user UUID      |
| `emailEnabled` | bool   | Enable/disable email  |
| `pushEnabled`  | bool   | Enable/disable push   |
| `inAppEnabled` | bool   | Enable/disable in-app |

**Response:** `{ success }`

---

# Data Models Reference

### Notification Types

`EMAIL` | `PUSH` | `IN_APP`

### Notification Statuses

`PENDING` | `SENT` | `FAILED` | `READ`

### Notification Priority

`LOW` | `MEDIUM` | `HIGH` | `CRITICAL`

### Campaign Statuses

`DRAFT` | `SCHEDULED` | `IN_PROGRESS` | `COMPLETED` | `FAILED`

---

## Quick Reference: Who Needs What

### 📱 Mobile App Developer

| Feature              | Endpoints                                            |
| -------------------- | ---------------------------------------------------- |
| Register for push    | `POST /api/v1/notifications/push/register-token`     |
| Unregister on logout | `DELETE /api/v1/notifications/push/unregister-token` |
| List notifications   | `GET /api/v1/notifications`                          |
| Mark as read         | `PATCH /api/v1/notifications/:id/read`               |
| Mark all read        | `PATCH /api/v1/notifications/read-all`               |
| Unread count (badge) | `GET /api/v1/notifications/unread-count`             |
| Delete notification  | `DELETE /api/v1/notifications/:id`                   |
| Get preferences      | `GET /api/v1/preferences`                            |
| Update preferences   | `PATCH /api/v1/preferences`                          |

### 🛠️ Admin Dashboard Developer

| Feature          | Endpoints                                    |
| ---------------- | -------------------------------------------- |
| Send to user     | `POST /api/v1/admin/notifications/send`      |
| Broadcast to all | `POST /api/v1/admin/notifications/broadcast` |
| View stats       | `GET /api/v1/admin/notifications/stats`      |
| Create campaign  | `POST /api/v1/admin/campaigns`               |
| List campaigns   | `GET /api/v1/admin/campaigns`                |
| Campaign details | `GET /api/v1/admin/campaigns/:id`            |
| Execute campaign | `POST /api/v1/admin/campaigns/:id/execute`   |
