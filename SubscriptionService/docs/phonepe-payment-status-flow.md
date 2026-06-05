# PhonePe Payments — How We Confirm Every Payment

**Audience:** Product, business & operations stakeholders
**Topic:** How OMGTV makes sure every PhonePe payment results in the right subscription — even when something goes wrong (app crash, lost network, missed webhook).
**Last updated:** 2026-06-05

---

## 1. The one-line summary

> When a user pays through PhonePe, we confirm that payment in **three independent ways**. If any one (or even two) of them fails, the others still catch it — so a paying customer **always** gets their subscription, and a non-paying user is **never** given access.

The safety net underneath all three is a single PhonePe API: the **Order Status API**, which lets us ask PhonePe directly *"did this payment actually go through?"*

---

## 2. Two kinds of PhonePe payments

| Payment type | When it happens | Plain meaning |
|---|---|---|
| **Setup order** | The very first payment | User subscribes for the first time. Also sets up the "mandate" (permission to charge them again later). |
| **Redemption order** | Every renewal after that | The monthly/quarterly auto-charge that keeps the subscription alive. |

This document focuses mainly on the **setup order** (the first payment), because that's where we recently added new protection. Renewals already had this protection.

---

## 3. The three ways we confirm a setup payment

When a user pays, here is everything that *should* happen — and the backups if it doesn't.

```
                    USER TAPS "PAY" IN PHONEPE
                              │
                              ▼
                      Payment succeeds
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
   (1) APP ASKS         (2) PHONEPE TELLS      (3) OUR SAFETY
       US TO VERIFY         US (WEBHOOK)           CRON CHECKS
        │                     │                     │
        ▼                     ▼                     ▼
   We check order        We provision the      Every 5 min we check
   status & activate     subscription          any "stuck" payment
        │                     │                     │
        └─────────────────────┴─────────────────────┘
                              ▼
                  SUBSCRIPTION IS ACTIVATED
                   (user gets access)
```

### Way 1 — The app asks us to verify (primary path)
Right after payment, the mobile app calls our `/purchase/verify` endpoint. We immediately ask PhonePe *"is this order complete?"* and, if yes, activate the subscription. **This is what happens 99% of the time.**

### Way 2 — PhonePe notifies us (webhook)
PhonePe also sends us an automatic message (a "webhook") saying the payment completed. **We recently upgraded this** so that it now fully activates the subscription by itself — previously it only made a note and relied on the app's verify call.

### Way 3 — Our safety cron (the new protection)
A background job runs **every 5 minutes**. It looks for any payment that is still "pending" in our system, asks PhonePe for its real status, and finishes the job — activating successful ones and closing failed/expired ones. **This is the new net that catches the rare case where both Way 1 and Way 2 fail** (e.g., our server was briefly down, or the app crashed right after payment).

---

## 4. The Order Status API we call

All three paths above rely on the **same PhonePe API** to get the truth about a payment.

| | Detail |
|---|---|
| **Purpose** | Check the real-time status of an order using our order ID |
| **Method** | `GET` |
| **Sandbox URL** | `https://api-preprod.phonepe.com/apis/pg-sandbox/checkout/v2/order/{merchantOrderId}/status` |
| **Production URL** | `https://api.phonepe.com/apis/pg/checkout/v2/order/{merchantOrderId}/status` |
| **What we send** | Our own order ID (e.g. `OMGTV_ORD_xxxxxxxx`) |
| **What we get back** | The order **state**: `COMPLETED`, `FAILED`, or `PENDING` |

### What each result means for us

| PhonePe says | Plain meaning | What we do |
|---|---|---|
| **COMPLETED** | Money was paid successfully | Activate the subscription |
| **FAILED** | Payment failed (e.g. wrong PIN) | Mark as failed, let the user retry |
| **PENDING** | Not paid yet / still processing | Wait and check again later. If the 15-minute payment window has closed, mark it failed. |

> **Important:** PhonePe never tells us "still pending" on its own — for pending payments **we have to ask**. That's exactly what our 5-minute cron does. Once a payment is COMPLETED, it stays COMPLETED forever, so there is no risk of "missing the window" to read a successful payment.

---

## 5. The webhook events PhonePe sends us

A webhook is an automatic message PhonePe pushes to us when something changes. We handle these:

| Webhook event | Meaning | Our action |
|---|---|---|
| `subscription.setup.order.completed` | First payment succeeded | **Activate the subscription** (newly upgraded) |
| `subscription.setup.order.failed` | First payment failed | Mark the transaction failed |
| `subscription.notification.completed` | Renewal pre-charge notice sent | Record it, ready to charge |
| `subscription.redemption.order.completed` | A renewal charge succeeded | Extend the subscription |
| `subscription.redemption.order.failed` | A renewal charge failed | Retry or cancel per rules |
| `subscription.paused` / `unpaused` | User paused mandate in their UPI app | Pause / resume access |
| `subscription.cancelled` / `revoked` | Mandate cancelled | Cancel the subscription |

Webhooks are fast and reliable **most** of the time — but they can be lost (network blip, our server restarting during a deploy). That is the entire reason the Order Status API + the 5-minute cron exist: **so a lost webhook never costs a customer their subscription.**

---

## 6. Coverage — every failure scenario is now handled

| Scenario | What recovers it |
|---|---|
| Everything works normally | App's `/purchase/verify` |
| App crashed, but webhook arrived | **Webhook now activates the subscription** (the gap we just closed) |
| Both the app verify AND webhook were lost | **5-minute safety cron** picks it up |
| User never actually paid | Cron marks it failed after the 15-min window (≈20 min) |
| Payment was attempted but failed | Verify / webhook / cron all mark it failed |

**Result: there is no longer any single point of failure that can leave a paying customer without their subscription.**

---

## 7. The trial → paid journey (example: ₹99 trial → ₹249 / 3 months)

```
Day 0   User buys ₹99 trial
        → Subscription created with status TRIAL  (full access)
        → A future renewal is scheduled at the real price (₹249)

~Trial  We notify PhonePe ~2 days before trial ends, then charge ₹249
 end    → On success: status becomes ACTIVE, access extended by 3 months
        → On failure: status becomes CANCELED (access until trial end, then removed)
```

- **TRIAL** and **ACTIVE** both give the user full ("premium") access.
- There is no separate "PREMIUM" status in our system — **ACTIVE is what the admin screens label "premium."**
- The price step-up (₹99 → ₹249) is built into the scheduled renewal, not charged upfront.

---

## 8. Razorpay vs PhonePe — why PhonePe needs more machinery

We support two payment providers. They reach the **same subscription statuses**, but the work is split differently:

| | Razorpay | PhonePe |
|---|---|---|
| Who schedules & runs the recurring charge | **Razorpay** (they own it) | **We do** (our background jobs) |
| Who triggers trial → paid | Razorpay charges, then tells us | Our renewal job charges, then we update |
| Order-status polling needed? | No (Razorpay manages it) | **Yes — this document** |

In short: **with Razorpay the provider drives billing; with PhonePe we drive it ourselves**, which is why PhonePe needs the verify + webhook + polling safety net described here.

---

## 9. What changed in this update (for the record)

**New capability added:** automatic recovery of first-time ("setup") PhonePe payments when the normal confirmation paths are missed.

- **New:** a shared activation routine used by every path so they all behave identically.
- **New:** a background job that polls PhonePe's Order Status API every 5 minutes for any stuck setup payment and finishes it.
- **Upgraded:** the PhonePe "setup completed" webhook now fully activates the subscription instead of just flagging the payment.
- **Unchanged:** the app verify flow and **all** Razorpay logic — no risk to existing Razorpay or active PhonePe users.

**Why it matters to the business:** fewer "I paid but didn't get access" support tickets, no manual fixes for lost webhooks, and a cleaner audit trail of every payment outcome.

---

## 10. Glossary

| Term | Plain meaning |
|---|---|
| **Setup order** | The first payment that creates a subscription |
| **Redemption order** | A renewal charge |
| **Mandate** | The user's standing permission for us to auto-charge them |
| **Webhook** | An automatic message PhonePe pushes to us when something changes |
| **Order Status API** | The PhonePe endpoint we call to ask "did this payment go through?" |
| **Verify** | The app's call to us right after payment to confirm and activate |
| **Cron** | A background job that runs automatically on a timer (ours: every 5 minutes) |
| **Idempotent** | Safe to run more than once — it won't double-charge or create duplicates |
