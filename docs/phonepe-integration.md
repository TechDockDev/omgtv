# PhonePe Subscription Integration — Technical & Stakeholder Document

**Product:** OMGTV  
**Integration:** PhonePe Subscription v2 (UPI Mandate)  
**Date:** June 2026  
**Status:** Production

---

## 1. Executive Summary

OMGTV now supports PhonePe as a payment provider alongside Razorpay. Users can subscribe to trial and premium plans using any UPI app (GPay, PhonePe, Paytm, BHIM, etc.) through PhonePe's UPI Mandate system.

Once a user sets up the mandate, all future renewals happen **automatically** — the user does not need to open the app or take any action for renewals. OMGTV's backend handles the entire billing cycle.

---

## 2. What We Support

| Feature | Supported |
|---|---|
| Trial plan purchase via UPI Mandate | ✅ |
| Premium/subscription plan purchase | ✅ |
| Auto-renewal (monthly / quarterly) | ✅ |
| Trial → Premium automatic upgrade | ✅ |
| User-initiated cancellation | ✅ |
| Access retained until billing period ends after cancel | ✅ |
| Payment failure handling + retry | ✅ |
| Duplicate payment protection | ✅ |
| Webhook-based real-time status sync | ✅ |
| Full PostHog analytics funnel | ✅ |

---

## 3. Plans & Pricing

| Plan | Type | Price | Duration | Mandate Ceiling |
|---|---|---|---|---|
| Trial | Trial | ₹99 | 30 days | ₹10,000 |
| Premium | Subscription | ₹249 | 90 days | ₹10,000 |

**Mandate Ceiling (₹10,000):** The maximum amount PhonePe is authorised to debit per transaction. Set high intentionally so future plan price changes never require users to re-setup their mandate.

---

## 4. How It Works — User Journey

### 4.1 New Subscription (Trial or Premium)

```
1. User opens OMGTV app → taps "Subscribe"
2. App calls backend: POST /api/v1/subscription/purchase/intent
   ↓
3. Backend creates UPI Mandate order on PhonePe
   Returns: orderToken, merchantOrderId, merchantSubscriptionId
   ↓
4. Flutter SDK opens PhonePe / UPI app using orderToken
   User approves UPI mandate (one-time setup, ~10 seconds)
   ↓
5. PhonePe charges ₹99 (trial) or ₹249 (premium) as penny drop
   SDK returns success to Flutter
   ↓
6. Flutter calls backend: POST /api/v1/subscription/purchase/verify
   ↓
7. Backend confirms payment with PhonePe, creates subscription
   User gets immediate access ✅
```

### 4.2 Auto-Renewal (Handled Entirely by Backend)

```
49 hours before subscription ends:
  Backend notifies PhonePe: "prepare to debit ₹249"
  ↓
24 hours later (25 hours before end):
  Backend executes debit via PhonePe mandate
  ↓
PhonePe debits user's UPI-linked bank account
  ↓
PhonePe sends webhook confirmation
  ↓
Backend extends subscription by 90 days
User never needs to do anything ✅
```

### 4.3 Cancellation

```
User taps "Cancel Subscription" in app
  ↓
POST /api/v1/subscription/me/cancel
  ↓
Backend:
  - Sets subscription status → CANCELLED
  - Cancels PhonePe mandate (no future charges)
  - Cancels any pending renewal orders
  ↓
User retains access until current period ends
After endsAt → access blocked automatically ✅
```

---

## 5. Backend Architecture

### 5.1 API Endpoints (Mobile-Facing)

| Method | Endpoint | Purpose | Auth |
|---|---|---|---|
| `POST` | `/api/v1/subscription/purchase/intent` | Create mandate & get order token | JWT |
| `POST` | `/api/v1/subscription/purchase/verify` | Confirm payment, activate subscription | JWT |
| `GET` | `/api/v1/subscription/me/subscription` | Get current subscription status | JWT |
| `POST` | `/api/v1/subscription/me/cancel` | Cancel subscription | JWT |

### 5.2 Purchase Intent Request & Response

**Request:**
```json
POST /api/v1/subscription/purchase/intent
{
  "planId": "<uuid>",
  "provider": "phonepe",
  "isTrial": true,
  "deviceId": "optional-device-id"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "transactionId": "uuid-stored-in-our-db",
    "provider": "phonepe",
    "orderToken": "TOKEN_FOR_FLUTTER_SDK",
    "phonePeOrderId": "ORD_xxx",
    "phonePeMerchantId": "OMGTV_MERCHANT_ID",
    "merchantOrderId": "OMGTV_ORD_xxx",
    "merchantSubscriptionId": "OMGTV_SUB_xxx",
    "amountPaise": 9900,
    "currency": "INR"
  }
}
```

### 5.3 Verify Payment Request & Response

**Request:**
```json
POST /api/v1/subscription/purchase/verify
{
  "provider": "phonepe",
  "transactionId": "uuid-from-intent-response",
  "merchantOrderId": "OMGTV_ORD_xxx",
  "merchantSubscriptionId": "OMGTV_SUB_xxx"
}
```

**Response (success):**
```json
{
  "success": true,
  "statusCode": 200,
  "userMessage": "Payment verified successfully",
  "data": { "status": "active" }
}
```

**Response (payment still processing):**
```json
{
  "success": false,
  "statusCode": 400,
  "code": "PAYMENT_PENDING",
  "userMessage": "Payment is still being processed. Please wait a moment and try again."
}
```

**Response (payment failed):**
```json
{
  "success": false,
  "statusCode": 400,
  "code": "PAYMENT_FAILED",
  "userMessage": "Payment failed. Please try again."
}
```

### 5.4 Subscription Status Response

```json
GET /api/v1/subscription/me/subscription?userId=<userId>

{
  "data": {
    "status": "TRIAL",           // TRIAL | ACTIVE | CANCELED | EXPIRED
    "isTrial": true,
    "planCancelled": false,      // true if user cancelled but still in period
    "endsAt": "2026-07-02T00:17:31Z",
    "provider": "phonepe",
    "displayPlan": { "name": "Trial Plan", ... },
    "planDisplayName": "1 Month Plan"
  }
}
```

### 5.5 Cancel Response

```json
POST /api/v1/subscription/me/cancel

{
  "success": true,
  "userMessage": "Your trial has been cancelled. You'll retain access until 2 Jul 2026.",
  "data": {
    "status": "canceled",
    "endsAt": "2026-07-02T00:17:31Z"
  }
}
```

---

## 6. Flutter SDK Integration

### 6.1 SDK Used

**PhonePe Payment SDK for Flutter**  
Package: `phonepe_payment_sdk` (official PhonePe Flutter plugin)

### 6.2 Full Purchase Flow (Flutter Code Pattern)

```dart
// Step 1: Get order token from backend
final intentResponse = await api.post('/api/v1/subscription/purchase/intent', {
  'planId': selectedPlan.id,
  'provider': 'phonepe',
  'isTrial': isTrial,
});

final transactionId     = intentResponse['data']['transactionId'];
final orderToken        = intentResponse['data']['orderToken'];
final merchantOrderId   = intentResponse['data']['merchantOrderId'];
final merchantSubId     = intentResponse['data']['merchantSubscriptionId'];
final merchantId        = intentResponse['data']['phonePeMerchantId'];

// Step 2: Open PhonePe SDK
final result = await PhonePePaymentSdk.startPGTransaction(
  body: '',
  callback: 'your-deep-link://callback',
  checksum: '',
  headers: {},
  merchantId: merchantId,
  package: null,
  tokenObj: {'token': orderToken},
);

// Step 3: Handle SDK result
if (result['status'] == 'SUCCESS') {
  // Step 4: Verify with backend
  final verifyResponse = await api.post('/api/v1/subscription/purchase/verify', {
    'provider': 'phonepe',
    'transactionId': transactionId,
    'merchantOrderId': merchantOrderId,
    'merchantSubscriptionId': merchantSubId,
  });

  if (verifyResponse['success'] == true) {
    // Show success screen
  } else if (verifyResponse['code'] == 'PAYMENT_PENDING') {
    // Retry verify after 3 seconds
    await Future.delayed(Duration(seconds: 3));
    // retry verifyPayment()
  } else {
    // Show failure screen
  }
} else {
  // User cancelled or payment failed in SDK
}
```

### 6.3 Cancel Subscription (Flutter)

```dart
final response = await api.post('/api/v1/subscription/me/cancel');

if (response['success'] == true) {
  final endsAt = response['data']['endsAt'];
  showDialog("Subscription cancelled. Access until $endsAt");
}
```

### 6.4 Show Cancelled State (Flutter)

```dart
final subResponse = await api.get('/api/v1/subscription/me/subscription');
final sub = subResponse['data'];

if (sub != null && sub['planCancelled'] == true) {
  // Show "Resubscribe" banner
  // Show "Access until [endsAt]" message
}
```

---

## 7. Billing Automation (Backend Cron Jobs)

No manual intervention needed for renewals. The system is fully automated.

### 7.1 Billing Schedule for a 90-Day Premium Plan

```
Day 0:    User pays ₹249 → mandate active → subscription starts
Day 88:   (90 days - 49 hours) → backend notifies PhonePe of upcoming debit
Day 89:   (24h after notify) → backend executes ₹249 debit via mandate
Day 89-90: PhonePe processes payment, webhook confirms
Day 90:   Subscription extended by 90 days → user never loses access
```

### 7.2 Billing Schedule for 30-Day Trial

```
Day 0:    User pays ₹99 trial → mandate active → trial starts
Day 28:   (30 days - 49 hours) → backend notifies PhonePe of ₹249 renewal
Day 29:   (24h after notify) → backend executes ₹249 debit
Day 29-30: PhonePe confirms → subscription transitions from TRIAL → ACTIVE
Day 30:   User seamlessly continues on Premium (90 days from renewal)
```

### 7.3 Cron Jobs

| Job | Frequency | Purpose |
|---|---|---|
| Billing cron | Every 15 min | Send notify → execute debit → handle failures |
| Reconciliation cron | Every 15 min | Recover missed webhook confirmations |
| Expiry cron | Every 1 hour | Mark expired subscriptions |

### 7.4 Payment Failure Handling

If auto-renewal payment fails:

```
Attempt 1: Execute debit → FAILED
  ↓ retryable error?
Attempt 2 (next 15 min cron): retry execute
  ↓ still failing?
Attempt 3: final attempt
  ↓ all failed or 72h window expired
Subscription → CANCELLED
PhonePe mandate → cancelled
User notified: "Subscription payment failed, please resubscribe"
```

---

## 8. Webhooks (PhonePe → OMGTV Backend)

PhonePe sends real-time events to:  
`POST /api/v1/subscription/webhooks/phonepe`

| Webhook Event | What We Do |
|---|---|
| `subscription.setup.order.completed` | Confirm mandate setup, mark transaction SUCCESS |
| `subscription.setup.order.failed` | Mark transaction FAILED, fire analytics |
| `subscription.notification.completed` | Mark redemption NOTIFIED, open 72h execute window |
| `subscription.notification.failed` | Log, cron will retry |
| `subscription.redemption.order.completed` | Mark SUCCESS, extend subscription, schedule next cycle |
| `subscription.redemption.order.failed` | Retry or mark FAILED, cancel if permanent |
| `subscription.paused` | Mark subscription PAUSED |
| `subscription.unpaused` | Mark subscription ACTIVE |
| `subscription.revoked` / `subscription.cancelled` | Cancel subscription, fire analytics |

---

## 9. Subscription Status Lifecycle

```
                    [User Pays]
                        │
                    TRIAL / ACTIVE
                        │
           ┌────────────┼────────────┐
           │            │            │
      [Renewal]   [User Cancels]  [Payment Fails]
           │            │            │
        ACTIVE      CANCELED      CANCELED
    (extended)   (access until    (access until
                   endsAt)         endsAt)
                        │            │
                   [endsAt passes]
                        │
                     EXPIRED
                  (access blocked)
```

---

## 10. Analytics & PostHog Events

Every key action fires a PostHog event for funnel analysis and churn tracking.

### 10.1 Acquisition Funnel

| Event | Fires When |
|---|---|
| `phonepe_purchase_started` | User initiates purchase |
| `phonepe_setup_failed` | PhonePe mandate setup failed (webhook) |
| `phonepe_payment_failed` | Payment order failed at verify |
| `trial_activated` | Trial subscription created |
| `first_trial_purchased` | User's very first trial ever |
| `subscription_activated` | Premium subscription created |
| `first_subscription_purchased` | User's very first premium ever |

### 10.2 Retention & Billing

| Event | Fires When |
|---|---|
| `phonepe_notify_success` | Renewal notify sent to PhonePe |
| `phonepe_notify_failed` | Notify failed (will retry) |
| `phonepe_execute_retry` | Debit retried |
| `phonepe_execute_failed` | Debit failed permanently |
| `subscription_renewed` | Renewal payment successful |
| `subscription_payment_failed` | Renewal payment failed permanently |

### 10.3 Churn

| Event | Fires When |
|---|---|
| `trial_cancelled` | User cancels trial |
| `subscription_cancelled` | User cancels premium |
| `trial_expired` | Trial expired without renewal |
| `subscription_expired` | Premium expired |
| `phonepe_window_expired` | 72h notify window closed without payment |

### 10.4 Operations

| Event | Fires When |
|---|---|
| `phonepe_reconciliation_recovery` | Missed webhook recovered by cron |
| `phonepe_mandate_exceeded` | Charge amount > mandate ceiling (should never happen) |
| `phonepe_notify_orphaned` | Notify row stuck after subscription expired |

---

## 11. Security & Safety

| Protection | How |
|---|---|
| **Duplicate payments** | `transactionId` unique constraint — concurrent verify calls blocked at DB level |
| **Double charges** | Optimistic lock on redemption rows — only one cron instance can execute |
| **Mandate ceiling** | All charges validated against ₹10,000 ceiling before API call |
| **Webhook auth** | SHA256(username:password) signature verified on every incoming webhook |
| **Service token** | All internal service calls require `x-service-token` header |
| **Redis lock** | Purchase intent locked per userId — prevents duplicate mandate setup |
| **Idempotency** | Every state transition is idempotent — safe to retry from any point |

---

## 12. Database Tables (PhonePe-Specific)

### `UserSubscription`
Stores the active subscription record. Key PhonePe fields:
- `provider: "phonepe"`
- `phonePeSubscriptionId` — PhonePe's mandate ID
- `mandateMaxAmount` — ceiling agreed at mandate setup (₹10,000)
- `status` — `TRIAL | ACTIVE | CANCELED | PAUSED | EXPIRED`

### `Transaction`
Records every payment attempt. Key fields:
- `subscriptionId` — merchantSubscriptionId (`OMGTV_SUB_xxx`)
- `metadata.merchantOrderId` — setup order ID (`OMGTV_ORD_xxx`)
- `status` — `PENDING | SUCCESS | FAILED`

### `PhonePeRedemption`
Tracks every billing cycle (notify → execute → confirm). One row per cycle:
- `cycleNumber` — 1 = setup, 2 = first renewal, 3 = second renewal, ...
- `status` — `PENDING_NOTIFY → NOTIFIED → EXECUTING → SUCCESS | FAILED`
- `scheduledNotifyAt` — exactly `endsAt - 49 hours`
- `notifyWindowEnd` — 72h after notify sent (PhonePe's execute deadline)

### `PhonePeEventLog`
Full audit log of every API call to/from PhonePe (inbound webhooks + outbound API calls). Retained for 180 days.

---

## 13. Known Limitations

| Limitation | Details |
|---|---|
| **No mandate reactivation** | Once a PhonePe mandate is cancelled, it cannot be reactivated. User must re-subscribe with a new mandate. |
| **ON_DEMAND billing** | We trigger every charge manually. If our cron is down for >72h, renewal window expires and user is not charged. |
| **UPI apps only** | PhonePe mandates only work with UPI-enabled bank accounts. Cards/net banking not supported through this flow. |
| **Single mandate per subscription** | One mandate per `merchantSubscriptionId`. If a user starts a new subscription, a new mandate is created. |

---

## 14. Environment Configuration

| Variable | Purpose |
|---|---|
| `PHONEPE_CLIENT_ID` | OAuth client ID |
| `PHONEPE_CLIENT_SECRET` | OAuth client secret |
| `PHONEPE_MERCHANT_ID` | Merchant identifier |
| `PHONEPE_ENV` | `PROD` or `UAT` |
| `PHONEPE_CLIENT_VERSION` | API client version |
| `PHONEPE_CALLBACK_USERNAME` | Webhook auth username |
| `PHONEPE_CALLBACK_PASSWORD` | Webhook auth password |

---

## 15. Summary for Stakeholders

**What has been built:**

1. **Full UPI subscription billing** — users pay with any UPI app, no card required
2. **Automatic renewals** — zero user action needed after initial setup
3. **Trial plan** — ₹99/month trial that auto-converts to ₹249/3 months
4. **Graceful cancellation** — users keep access until period end
5. **Failure recovery** — payment failures retried up to 3 times within 72 hours
6. **Real-time analytics** — every step of the funnel tracked in PostHog
7. **Full audit trail** — every PhonePe API call logged for 180 days
8. **Production-grade safety** — no double charges, no missed renewals, idempotent at every step

**Revenue flow:**
```
Trial ₹99 (Day 0)  →  Auto-renews ₹249 every 90 days thereafter
```

**User experience:**
```
Tap Subscribe → Approve UPI mandate (10 sec) → Done forever
All future charges happen silently in background
```
