# Subscription & Revenue Reporting Queries

This document explains the logic and SQL queries used to calculate user statistics, trial-to-subscription conversions, and canceled user reports.

## 1. Smart Comparison Logic (Trial vs. Subscriber)

Instead of relying solely on `trialPlanId`, the system now uses **Smart Comparison**. This is necessary because some users were on low-value trials (e.g., ₹1 or ₹5) that were technically mapped to full plans.

### Logic:
A user is considered a **TRIALIST** if:
1. They have a `trialPlanId` assigned.
2. **OR** The amount they paid (`transaction.amountPaise`) is **LESS THAN** the official price of the plan (`plan.pricePaise`).

### Equivalent SQL (Aggregated Stats):
```sql
SELECT 
    CASE 
        WHEN us."trialPlanId" IS NOT NULL OR t."amountPaise" < p."pricePaise" THEN 'TRIAL'
        ELSE 'SUBSCRIBER'
    END as user_category,
    CASE 
        WHEN us."endsAt" < NOW() OR us."status" = 'EXPIRED' THEN 'EXPIRED'
        ELSE 'ACTIVE'
    END as expiry_status,
    COUNT(*) as user_count
FROM "UserSubscription" us
LEFT JOIN "Plan" p ON us."planId" = p."id"
LEFT JOIN "Transaction" t ON us."transactionId" = t."id"
WHERE us."status" IN ('ACTIVE', 'CANCELED', 'TRIAL', 'EXPIRED')
GROUP BY 1, 2;
```

---

## 2. Trial-to-Subscription Conversion

This identifies users who started with a low-value "Trial" (official or unofficial) and subsequently paid for a full-price subscription.

### Logic:
1. Find users who have at least one transaction where `amountPaise` was low (e.g., < ₹10).
2. For those users, find a subsequent transaction where they paid the **full price** of a plan.
3. Verify they currently have an active or recently expired subscription.

### Equivalent SQL:
```sql
WITH TrialUsers AS (
    -- Users who paid less than ₹10 at some point
    SELECT DISTINCT "userId" 
    FROM "Transaction" 
    WHERE "amountPaise" < 1000 AND "status" = 'SUCCESS'
),
ConvertedUsers AS (
    -- Of those trial users, who paid for a full plan later?
    SELECT 
        tu."userId",
        MIN(t."createdAt") as converted_at
    FROM TrialUsers tu
    JOIN "Transaction" t ON tu."userId" = t."userId"
    JOIN "Plan" p ON t."amountPaise" = p."pricePaise" -- Paid exactly the plan price
    WHERE t."status" = 'SUCCESS'
    GROUP BY tu."userId"
)
SELECT 
    c.id as user_id,
    cv.converted_at,
    us.status as current_status,
    p.name as current_plan
FROM ConvertedUsers cv
JOIN "AuthSubject" c ON cv."userId" = c.id
JOIN "UserSubscription" us ON cv."userId" = us."userId"
JOIN "Plan" p ON us."planId" = p.id
ORDER BY cv.converted_at DESC;
```

---

## 3. Canceled Users Statistics

This identifies users who have canceled their auto-renewal but still have active time left.

### Equivalent SQL:
```sql
SELECT 
    CASE 
        WHEN us."trialPlanId" IS NOT NULL OR t."amountPaise" < p."pricePaise" THEN 'TRIAL'
        ELSE 'SUBSCRIBER'
    END as type,
    COUNT(*) as canceled_count
FROM "UserSubscription" us
LEFT JOIN "Plan" p ON us."planId" = p."id"
LEFT JOIN "Transaction" t ON us."transactionId" = t."id"
WHERE us."status" = 'CANCELED' 
  AND us."endsAt" > NOW()
GROUP BY 1;
```

---

## 4. Why numbers might look different in Razorpay vs Admin Panel

| Context | Razorpay Dashboard | Admin Dashboard |
| :--- | :--- | :--- |
| **Subscriber Count** | Usually counts every "Active" subscription record. | Counts unique users who paid **Full Price**. |
| **Trial Count** | May only count formal `trial_plan` entities. | Counts everyone who paid **Low Amounts** (₹1/₹5) regardless of plan ID. |
| **Conversion Rate** | Often based on `trial_end` webhook. | Based on **actual payment transition** (Low Pay -> Full Pay). |

---
**Document generated on 2026-05-12.** Syncing status
