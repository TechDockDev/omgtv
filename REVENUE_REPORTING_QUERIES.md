# Master Revenue & Conversion Audit

This is the **Master Query** used to monitor the entire subscription ecosystem. It reconciles Master Truth (Payments) with current Database Status and tracks conversions and cancellations.

```sql
-- MASTER REVENUE & CONVERSION AUDIT (V4)
-- One query to see everything: Categories, States, Conversions, Cancellations, and Grand Totals.
WITH UserRevenue AS (
    SELECT 
        "userId", 
        SUM("amountPaise") as total_paid,
        MIN("amountPaise") as first_paid_amount,
        COUNT(*) as tx_count
    FROM "Transaction" 
    WHERE "status" = 'SUCCESS' 
    GROUP BY "userId"
),
UserStatus AS (
    SELECT DISTINCT ON ("userId") 
        "userId", "status", "endsAt"
    FROM "UserSubscription" 
    ORDER BY "userId", "createdAt" DESC
),
ConversionCheck AS (
    SELECT "userId" 
    FROM UserRevenue 
    WHERE first_paid_amount < 9900 AND total_paid >= 9900
),
DetailedData AS (
    SELECT 
        r."userId" as "User_ID",
        CASE WHEN r.total_paid >= 9900 THEN 'SUBSCRIBER (₹99+)' ELSE 'TRIAL (₹1-₹9)' END as "User_Category",
        CASE 
            WHEN s."status" = 'ACTIVE' AND s."endsAt" >= NOW() THEN 'ACTIVE (Watching)'
            WHEN s."status" = 'TRIAL' AND s."endsAt" >= NOW() THEN 'ACTIVE (Watching)'
            WHEN s."status" = 'CANCELED' AND s."endsAt" >= NOW() THEN 'AUTO-PAY OFF (Has Access)'
            WHEN s."status" = 'CANCELED' AND s."endsAt" < NOW() THEN 'EXPIRED (Canceled)'
            WHEN s."status" = 'EXPIRED' THEN 'EXPIRED (Blocked)'
            ELSE 'EXPIRED (Legacy/Orphan)'
        END as "Current_State",
        CASE WHEN c."userId" IS NOT NULL THEN 'Trial_Converted' ELSE 'Direct_Purchase' END as "Acquisition_Type",
        (r.total_paid / 100.0) as "Revenue_INR",
        r.tx_count as "Payment_Count"
    FROM UserRevenue r
    LEFT JOIN UserStatus s ON r."userId" = s."userId"
    LEFT JOIN ConversionCheck c ON r."userId" = c."userId"
)
-- 1. INDIVIDUAL USER DATA
SELECT * FROM DetailedData
UNION ALL
SELECT '---','---','---','---',NULL,NULL
UNION ALL
-- 2. DETAILED SUMMARY BUCKETS (By Category + State)
SELECT 'SUMMARY: ' || "User_Category", "User_Category", "Current_State", 'Users: ' || COUNT(*), SUM("Revenue_INR"), SUM("Payment_Count")
FROM DetailedData GROUP BY "User_Category", "Current_State"
UNION ALL
-- 3. CATEGORY TOTALS
SELECT 'TOTAL: ' || "User_Category", "User_Category", 'ALL STATES', 'Total: ' || COUNT(*), SUM("Revenue_INR"), SUM("Payment_Count")
FROM DetailedData GROUP BY "User_Category"
UNION ALL
-- 4. CANCELLATION TOTALS
SELECT 'TOTAL CANCELED: ' || "User_Category", "User_Category", 'CANCELED', 'Total: ' || COUNT(*), SUM("Revenue_INR"), SUM("Payment_Count")
FROM DetailedData WHERE "Current_State" IN ('AUTO-PAY OFF (Has Access)', 'EXPIRED (Canceled)') GROUP BY "User_Category"
UNION ALL
-- 5. CONVERSION ANALYTICS (By State)
SELECT 'SUMMARY: CONVERSIONS', 'TRIAL -> SUB', "Current_State", 'Converted: ' || COUNT(*), SUM("Revenue_INR"), SUM("Payment_Count")
FROM DetailedData WHERE "Acquisition_Type" = 'Trial_Converted' GROUP BY "Current_State"
UNION ALL
-- 6. OVERALL CONVERSION TOTAL
SELECT 'TOTAL CONVERSIONS (OVERALL)', 'TRIAL -> SUB', 'ALL STATES', 'Total: ' || COUNT(*), SUM("Revenue_INR"), SUM("Payment_Count")
FROM DetailedData WHERE "Acquisition_Type" = 'Trial_Converted'
UNION ALL
-- 7. GRAND TOTAL
SELECT 'GRAND TOTAL', 'ALL USERS', '---', 'Total Users: ' || COUNT(*), SUM("Revenue_INR"), SUM("Payment_Count")
FROM DetailedData
ORDER BY 1 DESC, 2 ASC, 5 DESC;
```

---

# Detailed Analysis Queries

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
LEFT JOIN "SubscriptionPlan" p ON us."planId" = p."id"
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
    JOIN "SubscriptionPlan" p ON t."amountPaise" = p."pricePaise" -- Paid exactly the plan price
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
JOIN "SubscriptionPlan" p ON us."planId" = p.id
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
LEFT JOIN "SubscriptionPlan" p ON us."planId" = p."id"
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



-- RECONCILIATION REPORT (BY USER ID)
WITH UserPayments AS (
    SELECT 
        "userId",
        SUM("amountPaise") as total_paid_paise,
        MAX("createdAt") as last_payment_date,
        COUNT(*) as total_transactions
    FROM "Transaction"
    WHERE "status" = 'SUCCESS'
    GROUP BY "userId"
),
LatestSubscription AS (
    SELECT DISTINCT ON ("userId") 
        "userId", 
        "status", 
        "endsAt", 
        "planId",
        "createdAt"
    FROM "UserSubscription"
    ORDER BY "userId", "createdAt" DESC
),
DetailedData AS (
    SELECT 
        up."userId" as "User ID",
        CASE 
            WHEN up.total_paid_paise >= 9900 THEN 'SUBSCRIBER'
            ELSE 'TRIAL'
        END as "Category",
        COALESCE(ls."status"::text, 'ACTIVE (Orphan Transaction)') as "Status",
        (up.total_paid_paise / 100.0) as "Paid (₹)",
        up.last_payment_date as "Last Payment",
        COALESCE(ls."endsAt", up.last_payment_date + interval '30 days') as "Expiry",
        up.total_transactions as "TX Count"
    FROM UserPayments up
    LEFT JOIN LatestSubscription ls ON up."userId" = ls."userId"
    WHERE up.total_paid_paise > 0
)
-- Part 1: Individual Rows
SELECT * FROM DetailedData

UNION ALL

-- Part 2: Separator
SELECT '---', '---', '---', NULL, NULL, NULL, NULL

UNION ALL

-- Part 3: Category Totals
SELECT 
    'SUMMARY', 
    "Category", 
    'TOTAL COUNT: ' || COUNT(*), 
    SUM("Paid (₹)"), 
    NULL, 
    NULL, 
    SUM("TX Count")
FROM DetailedData
GROUP BY "Category"

UNION ALL

-- Part 4: Grand Total
SELECT 
    'SUMMARY', 
    'GRAND TOTAL', 
    'TOTAL USERS: ' || COUNT(*), 
    SUM("Paid (₹)"), 
    NULL, 
    NULL, 
    SUM("TX Count")
FROM DetailedData

ORDER BY 1 DESC, 2 ASC, 4 DESC;

-- TRIAL TO SUBSCRIPTION CONVERSION REPORT
-- Logic: Users who started as trials and whose cumulative payments crossed ₹99
WITH UserPayments AS (
    SELECT 
        "userId",
        "amountPaise",
        "createdAt",
        SUM("amountPaise") OVER (PARTITION BY "userId" ORDER BY "createdAt") as cumulative_paid
    FROM "Transaction"
    WHERE "status" = 'SUCCESS'
),
TrialThresholds AS (
    -- Users who either have a recorded trial subscription OR at some point had < ₹99 total payments
    SELECT DISTINCT "userId" FROM "UserSubscription" WHERE "trialPlanId" IS NOT NULL
    UNION
    SELECT DISTINCT "userId" FROM UserPayments WHERE cumulative_paid < 9900
),
ConversionEvents AS (
    -- Find the exact timestamp when a user's cumulative payments first reached/exceeded ₹99
    SELECT 
        "userId",
        MIN("createdAt") as converted_at
    FROM UserPayments
    WHERE cumulative_paid >= 9900
      AND "userId" IN (SELECT "userId" FROM TrialThresholds)
    GROUP BY "userId"
),
DetailedData AS (
    SELECT 
        ce."userId" as "User ID",
        'SUBSCRIBER (Converted)' as "Category",
        COALESCE(ls."status"::text, 'ACTIVE (Orphan)') as "Status",
        (SELECT SUM("amountPaise")/100.0 FROM "Transaction" WHERE "userId" = ce."userId" AND "status" = 'SUCCESS') as "Total Paid (₹)",
        ce.converted_at as "Conversion Date",
        COALESCE(ls."endsAt", ce.converted_at + interval '30 days') as "Expiry"
    FROM ConversionEvents ce
    LEFT JOIN (
        SELECT DISTINCT ON ("userId") "userId", "status", "endsAt"
        FROM "UserSubscription"
        ORDER BY "userId", "createdAt" DESC
    ) ls ON ce."userId" = ls."userId"
)
SELECT * FROM DetailedData
ORDER BY "Conversion Date" DESC;


-- INTENTIONAL CANCELLATIONS REPORT (AUTO-RENEW OFF)
-- Logic: Users with status 'CANCELED' categorized by cumulative payment threshold
WITH UserPayments AS (
    SELECT 
        "userId",
        SUM("amountPaise") as total_paid_paise
    FROM "Transaction"
    WHERE "status" = 'SUCCESS'
    GROUP BY "userId"
),
LatestCanceledSubscription AS (
    -- Get the most recent cancellation for each user
    SELECT DISTINCT ON ("userId") 
        "userId", 
        "status", 
        "endsAt", 
        "updatedAt" as "canceledAt",
        "planId",
        "trialPlanId"
    FROM "UserSubscription"
    WHERE "status" = 'CANCELED'
    ORDER BY "userId", "updatedAt" DESC
),
DetailedData AS (
    SELECT 
        lcs."userId" as "User ID",
        CASE 
            WHEN COALESCE(up.total_paid_paise, 0) >= 9900 THEN 'SUBSCRIBER'
            ELSE 'TRIAL'
        END as "Category",
        lcs."status" as "Status",
        (COALESCE(up.total_paid_paise, 0) / 100.0) as "Paid (₹)",
        lcs."canceledAt" as "Canceled At",
        lcs."endsAt" as "Entitlement Expiry"
    FROM LatestCanceledSubscription lcs
    LEFT JOIN UserPayments up ON lcs."userId" = up."userId"
)
SELECT * FROM DetailedData
ORDER BY "Canceled At" DESC;


-- LONG-RUNNING TRIALS REPORT (AGE > 7 DAYS)
-- Logic: Users still in 'TRIAL' category whose first transaction or trial start was more than 7 days ago
WITH UserPayments AS (
    SELECT 
        "userId",
        SUM("amountPaise") as total_paid_paise,
        MIN("createdAt") as first_payment_date
    FROM "Transaction"
    WHERE "status" = 'SUCCESS'
    GROUP BY "userId"
),
TrialSubscriptions AS (
    -- Find the very first trial start for each user
    SELECT DISTINCT ON ("userId") 
        "userId", 
        "createdAt" as trial_started_at,
        "endsAt"
    FROM "UserSubscription"
    WHERE "trialPlanId" IS NOT NULL
    ORDER BY "userId", "createdAt" ASC
),
DetailedData AS (
    SELECT 
        COALESCE(ts."userId", up."userId") as "User ID",
        CASE 
            WHEN COALESCE(up.total_paid_paise, 0) >= 9900 THEN 'SUBSCRIBER'
            ELSE 'TRIAL'
        END as "Category",
        COALESCE(ts.trial_started_at, up.first_payment_date) as "First Seen (Start Date)",
        EXTRACT(DAY FROM (NOW() - COALESCE(ts.trial_started_at, up.first_payment_date))) as "Days Since Start"
    FROM UserPayments up
    FULL OUTER JOIN TrialSubscriptions ts ON up."userId" = ts."userId"
)
SELECT * 
FROM DetailedData 
WHERE "Category" = 'TRIAL' 
  AND "Days Since Start" > 7
ORDER BY "Days Since Start" DESC;

---

## 5. Subscription Health Check (Executive Summary)

This is the ultimate query to monitor the health of your subscription system. It reconciles Master Truth (Payments) with current Database Status and identifies potential leakage.

### Logic:
1. **User_Type**: Based on cumulative successful payments (₹99+ = Subscriber, < ₹99 = Trialist).
2. **Current_State**: Combines database status with expiration dates to show who actually has access.

### Final Reporting SQL:
```sql
-- EXECUTIVE SUMMARY: SUBSCRIBERS VS TRIALISTS
WITH UserRevenue AS (
    -- Identify Category based on TOTAL spent in life (Master Truth)
    SELECT 
        "userId", 
        SUM("amountPaise") as total_paid
    FROM "Transaction" 
    WHERE "status" = 'SUCCESS' 
    GROUP BY "userId"
),
UserStatus AS (
    -- Identify current Status and Expiry from Subscription table (Latest Record)
    SELECT DISTINCT ON ("userId") 
        "userId", 
        "status", 
        "endsAt"
    FROM "UserSubscription" 
    ORDER BY "userId", "createdAt" DESC
)
SELECT 
    CASE WHEN r.total_paid >= 9900 THEN 'SUBSCRIBER (₹99+)' ELSE 'TRIAL (₹1-₹9)' END as "User_Type",
    CASE 
        WHEN s."status" = 'ACTIVE' AND s."endsAt" >= NOW() THEN 'ACTIVE (Watching)'
        WHEN s."status" = 'TRIAL' AND s."endsAt" >= NOW() THEN 'ACTIVE (Watching)'
        WHEN s."status" = 'CANCELED' AND s."endsAt" >= NOW() THEN 'AUTO-PAY OFF (Still has Access)'
        WHEN s."status" = 'CANCELED' AND s."endsAt" < NOW() THEN 'EXPIRED (Auto-pay was off)'
        WHEN s."status" = 'EXPIRED' THEN 'EXPIRED (Access Blocked)'
        ELSE 'EXPIRED (Access Blocked)'
    END as "Current_State",
    COUNT(*) as "User_Count"
FROM UserRevenue r
LEFT JOIN UserStatus s ON r."userId" = s."userId"
GROUP BY 1, 2
ORDER BY 1, 2;
```

---

## 6. Automated Cleanup (Background Job)

To prevent revenue leakage, a background job runs every 1 hour in the `SubscriptionService`. This job automatically marks stale subscriptions as `EXPIRED` if their `endsAt` date has passed.

### Automated Logic:
```sql
-- This query runs hourly via the 'expireSubscriptions' cron job
UPDATE "UserSubscription"
SET "status" = 'EXPIRED', "updatedAt" = NOW()
WHERE "status" IN ('ACTIVE', 'TRIAL', 'CANCELED')
  AND "endsAt" < NOW();
```

**Last Sync: 2026-05-13.** All leakage resolved.
