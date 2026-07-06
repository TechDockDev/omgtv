import { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPrisma } from "../../lib/prisma";
import { loadConfig } from "../../config";
import { getRedis } from "../../lib/redis";
import { FUNNELS, FUNNEL_IDS } from "../../lib/funnel-definitions";
import { queryPostHogFunnel } from "../../lib/posthog-query";

interface CohortBucket {
  period: string;
  userIds: string[];
  count: number;
}

interface LifecycleRow {
  period: string;
  registrations: number;
  freeUsers: number;
  freePercent: number;
  trialStarted: number;
  regToTrialPercent: number;
  trialActive: number;
  trialCancelled: number;
  trialExpired: number;
  convertedFromTrial: number;
  trialToSubConvPercent: number;
  subActive: number;
  subCancelled: number;
  subExpired: number;
  totalSubscribed: number;
  renewedSubs: number;
  subChurned: number;
  subChurnPercent: number;
  reactivated: number;
  recoveryPercent: number;
  razorpayUsers: number;
  phonePeUsers: number;
  razorpayPercent: number;
  phonePePercent: number;
}

function pct(num: number, den: number): number {
  return den > 0 ? +((num / den) * 100).toFixed(1) : 0;
}

function buildRow(period: string, counts: Omit<LifecycleRow, "period" | "freePercent" | "regToTrialPercent" | "trialToSubConvPercent" | "subChurnPercent" | "recoveryPercent" | "razorpayPercent" | "phonePePercent">): LifecycleRow {
  return {
    period,
    registrations: counts.registrations,
    freeUsers: counts.freeUsers,
    freePercent: pct(counts.freeUsers, counts.registrations),
    trialStarted: counts.trialStarted,
    regToTrialPercent: pct(counts.trialStarted, counts.registrations),
    trialActive: counts.trialActive,
    trialCancelled: counts.trialCancelled,
    trialExpired: counts.trialExpired,
    convertedFromTrial: counts.convertedFromTrial,
    trialToSubConvPercent: pct(counts.convertedFromTrial, counts.trialStarted),
    subActive: counts.subActive,
    subCancelled: counts.subCancelled,
    subExpired: counts.subExpired,
    totalSubscribed: counts.totalSubscribed,
    subChurned: counts.subChurned,
    subChurnPercent: pct(counts.subChurned, counts.totalSubscribed),
    renewedSubs: counts.renewedSubs,
    reactivated: counts.reactivated,
    recoveryPercent: pct(counts.reactivated, counts.subChurned),
    razorpayUsers: counts.razorpayUsers,
    phonePeUsers: counts.phonePeUsers,
    razorpayPercent: pct(counts.razorpayUsers, counts.registrations),
    phonePePercent: pct(counts.phonePeUsers, counts.registrations),
  };
}

function zeroCounters() {
  return {
    registrations: 0,
    freeUsers: 0,
    trialStarted: 0,
    trialActive: 0,
    trialCancelled: 0,
    trialExpired: 0,
    convertedFromTrial: 0,
    subActive: 0,
    subCancelled: 0,
    subExpired: 0,
    totalSubscribed: 0,
    subChurned: 0,
    renewedSubs: 0,
    reactivated: 0,
    razorpayUsers: 0,
    phonePeUsers: 0,
  };
}

export default async function analyticsAdminRoutes(app: FastifyInstance) {
  const prisma = getPrisma();

  /**
   * GET /api/v1/subscription/admin/analytics/lifecycle
   *
   * Filters:
   *   startDate  — YYYY-MM-DD (IST)
   *   endDate    — YYYY-MM-DD (IST)
   *   period     — "daily" | "monthly"  (default: monthly)
   *   platform   — "all" | "android" | "ios"  (default: all)
   *
   * Response:
   *   overall — sum row across all periods
   *   rows    — one row per period. Every column counts users by the date the
   *             EVENT happened (trial started, first paid sub, cancellation,
   *             expiry, renewal) — NOT by registration cohort. This makes the
   *             numbers line up with the transactions screen for the same range.
   *             EXCEPTION: convertedFromTrial is attributed to the period the
   *             trial STARTED, so trialToSubConvPercent in each row measures
   *             that row's own trial batch.
   */
  app.get("/analytics/lifecycle", {
    schema: {
      querystring: z.object({
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        period: z.enum(["daily", "monthly"]).optional().default("monthly"),
        platform: z.enum(["all", "android", "ios"]).optional().default("all"),
      }),
    },
  }, async (request, reply) => {
    const { startDate, endDate, period = "monthly", platform = "all" } =
      request.query as { startDate?: string; endDate?: string; period: "daily" | "monthly"; platform: "all" | "android" | "ios" };

    const config = loadConfig();
    const serviceToken = config.SERVICE_AUTH_TOKEN ?? "";
    const now = new Date();

    const start = startDate
      ? new Date(`${startDate}T00:00:00.000+05:30`)
      : new Date("2020-01-01T00:00:00.000Z");
    // endDate is INCLUSIVE (same as /admin/all-transactions) — the full endDate day counts
    const end = endDate ? new Date(`${endDate}T23:59:59.999+05:30`) : now;

    const periodKey = (d: Date): string => {
      const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
      return period === "daily" ? ist.toISOString().slice(0, 10) : ist.toISOString().slice(0, 7);
    };
    const inRange = (d: Date) => d >= start && d < end;

    // ── Step 1: Registration cohorts from AuthService (per-period counts) ─────
    const authParams = new URLSearchParams({ period });
    if (startDate) authParams.set("startDate", startDate);
    if (endDate) authParams.set("endDate", endDate);

    let cohorts: CohortBucket[];
    try {
      const res = await fetch(
        `${config.AUTH_SERVICE_URL}/internal/analytics/registrations?${authParams}`,
        { headers: { "x-service-token": serviceToken } }
      );
      if (!res.ok) {
        request.log.error({ status: res.status }, "AuthService /registrations failed");
        return reply.code(502).send({ error: "AuthService unavailable" });
      }
      const data = await res.json() as { cohorts: CohortBucket[] };
      cohorts = data.cohorts;
    } catch (err) {
      request.log.error(err, "AuthService /registrations fetch error");
      return reply.code(502).send({ error: "AuthService unavailable" });
    }

    // ── Step 2: Full subscription + transaction history up to `end` ───────────
    // History BEFORE `start` is needed too: prior-trial and prior-cancellation
    // checks (conversion, reactivation, renewal) look at events that may predate
    // the filter window. This is NOT restricted to registration cohorts — users
    // who registered before the window but transacted inside it must be counted.
    const [subs, txs] = await Promise.all([
      prisma.userSubscription.findMany({
        where: { createdAt: { lt: end }, status: { not: "PENDING" } },
        select: {
          id: true, userId: true, planId: true, trialPlanId: true, status: true,
          provider: true, startsAt: true, endsAt: true, createdAt: true, updatedAt: true,
        },
        orderBy: { createdAt: "asc" },
      }),
      prisma.transaction.findMany({
        where: { createdAt: { lt: end }, status: "SUCCESS" },
        select: { userId: true, subscriptionId: true, planId: true, trialPlanId: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      }),
    ]);

    // ── Step 3: Optional platform filter (registrations AND activity users) ───
    let allowed: Set<string> | null = null;
    if (platform !== "all") {
      const ids = new Set<string>();
      for (const c of cohorts) for (const uid of c.userIds) ids.add(uid);
      for (const s of subs) ids.add(s.userId);
      try {
        const res = await fetch(
          `${config.USER_SERVICE_URL}/internal/analytics/filter-by-platform`,
          {
            method: "POST",
            headers: { "content-type": "application/json", "x-service-token": serviceToken },
            body: JSON.stringify({ authIds: Array.from(ids), os: platform }),
          }
        );
        if (res.ok) {
          const data = await res.json() as { authIds: string[] };
          allowed = new Set(data.authIds);
        } else {
          request.log.warn({ status: res.status }, "UserService filter-by-platform failed — skipping platform filter");
        }
      } catch (err) {
        request.log.warn(err, "UserService filter-by-platform error — skipping platform filter");
      }
    }
    const isAllowed = (uid: string) => allowed === null || allowed.has(uid);

    // ── Step 4: Aggregate — every metric bucketed by ITS OWN event date ───────
    const periodCounters = new Map<string, ReturnType<typeof zeroCounters>>();
    const counterFor = (p: string) => {
      let c = periodCounters.get(p);
      if (!c) { c = zeroCounters(); periodCounters.set(p, c); }
      return c;
    };
    // dedupe: one increment per user per period per metric
    const seen = new Set<string>();
    const addOnce = (metric: keyof ReturnType<typeof zeroCounters>, p: string, uid: string) => {
      const k = `${metric}|${p}|${uid}`;
      if (seen.has(k)) return;
      seen.add(k);
      counterFor(p)[metric]++;
    };

    // Registrations + free users (registered in period, zero subscription activity ever)
    const usersWithAnySub = new Set(subs.map((s) => s.userId));
    for (const c of cohorts) {
      const uids = c.userIds.filter(isAllowed);
      if (uids.length === 0) continue;
      const counter = counterFor(c.period);
      counter.registrations += uids.length;
      for (const uid of uids) {
        if (!usersWithAnySub.has(uid)) counter.freeUsers++;
      }
    }

    // Per-user trial/paid evidence from BOTH tables — the Razorpay webhook
    // trial→paid path clears trialPlanId on UserSubscription, but the original
    // trial Transaction always keeps it.
    const trialStartAt = new Map<string, Date>();
    const firstPaidAt = new Map<string, Date>();
    // Users with a dedicated paid UserSubscription row. PhonePe converts trial→paid
    // by re-billing the SAME record (trialPlanId stays set), so converted PhonePe
    // users are NOT in this set — their paid evidence comes from Transaction only.
    const paidSubUsers = new Set<string>();
    for (const s of subs) {
      const at = s.startsAt ?? s.createdAt;
      if (s.trialPlanId) {
        const cur = trialStartAt.get(s.userId);
        if (!cur || at < cur) trialStartAt.set(s.userId, at);
      } else if (s.planId) {
        paidSubUsers.add(s.userId);
        const cur = firstPaidAt.get(s.userId);
        if (!cur || at < cur) firstPaidAt.set(s.userId, at);
      }
    }
    for (const t of txs) {
      if (t.trialPlanId) {
        const cur = trialStartAt.get(t.userId);
        if (!cur || t.createdAt < cur) trialStartAt.set(t.userId, t.createdAt);
      } else if (t.planId) {
        const cur = firstPaidAt.get(t.userId);
        if (!cur || t.createdAt < cur) firstPaidAt.set(t.userId, t.createdAt);
      }
    }

    type SubRow = (typeof subs)[number];
    const subsByUser = new Map<string, SubRow[]>();
    for (const s of subs) {
      let arr = subsByUser.get(s.userId);
      if (!arr) { arr = []; subsByUser.set(s.userId, arr); }
      arr.push(s);
    }

    for (const s of subs) {
      if (!isAllowed(s.userId)) continue;
      const isTrial = s.trialPlanId !== null;
      const isPaid = !isTrial && s.planId !== null;
      const startedAt = s.startsAt ?? s.createdAt;

      if (isTrial) {
        if (inRange(startedAt)) {
          const p = periodKey(startedAt);
          addOnce("trialStarted", p, s.userId);
          if (s.provider === "razorpay") addOnce("razorpayUsers", p, s.userId);
          if (s.provider === "phonepe") addOnce("phonePeUsers", p, s.userId);
          // still on trial now, and never converted to paid
          if (!firstPaidAt.has(s.userId) && (s.status === "TRIAL" || s.status === "ACTIVE") &&
              s.endsAt && s.endsAt > now) {
            addOnce("trialActive", p, s.userId);
          }
        }
        // If the user converted to paid BEFORE this status change, the event belongs
        // to the paid buckets, not the trial buckets. For PhonePe (no separate paid
        // row) route it to sub*; for Razorpay (separate paid row exists) the paid
        // row already tracks it — just don't double-count as a trial event.
        const paidAt = firstPaidAt.get(s.userId);
        const convertedBefore = (d: Date) => paidAt !== undefined && paidAt <= d;
        if (s.status === "CANCELED" && inRange(s.updatedAt)) {
          if (!convertedBefore(s.updatedAt)) {
            addOnce("trialCancelled", periodKey(s.updatedAt), s.userId);
          } else if (!paidSubUsers.has(s.userId)) {
            addOnce("subCancelled", periodKey(s.updatedAt), s.userId);
          }
        }
        if (s.status === "EXPIRED" && inRange(s.updatedAt)) {
          if (!convertedBefore(s.updatedAt)) {
            addOnce("trialExpired", periodKey(s.updatedAt), s.userId);
          } else if (!paidSubUsers.has(s.userId)) {
            addOnce("subExpired", periodKey(s.updatedAt), s.userId);
            addOnce("subChurned", periodKey(s.updatedAt), s.userId);
          }
        }
        // Converted PhonePe user who cancelled and whose access period has lapsed
        if (s.status === "CANCELED" && convertedBefore(s.updatedAt) && !paidSubUsers.has(s.userId) &&
            s.endsAt && s.endsAt <= now && inRange(s.endsAt)) {
          addOnce("subChurned", periodKey(s.endsAt), s.userId);
        }
      }

      if (isPaid) {
        if (inRange(startedAt)) {
          const p = periodKey(startedAt);
          if (s.provider === "razorpay") addOnce("razorpayUsers", p, s.userId);
          if (s.provider === "phonepe") addOnce("phonePeUsers", p, s.userId);
          // has access right now (ACTIVE, or CANCELED with access period not yet ended)
          if (s.endsAt && s.endsAt > now && (s.status === "ACTIVE" || s.status === "CANCELED")) {
            addOnce("subActive", p, s.userId);
          }
        }
        if (s.status === "CANCELED" && inRange(s.updatedAt)) {
          addOnce("subCancelled", periodKey(s.updatedAt), s.userId);
        }
        if (s.status === "EXPIRED" && inRange(s.updatedAt)) {
          addOnce("subExpired", periodKey(s.updatedAt), s.userId);
          addOnce("subChurned", periodKey(s.updatedAt), s.userId);
        } else if (s.status === "CANCELED" && s.endsAt && s.endsAt <= now && inRange(s.endsAt)) {
          addOnce("subChurned", periodKey(s.endsAt), s.userId);
        }
      }

      // Reactivated: this sub (trial or paid) started after a prior CANCELED sub ended
      if (inRange(startedAt)) {
        const history = subsByUser.get(s.userId) ?? [];
        const hadPriorCancel = history.some(
          (o) => o.id !== s.id && o.status === "CANCELED" && o.endsAt && o.endsAt < startedAt
        );
        if (hadPriorCancel) addOnce("reactivated", periodKey(startedAt), s.userId);
      }
    }

    // New paying subscribers (bucketed by first-paid date) + trial→paid conversions
    // (bucketed by the period the TRIAL STARTED — cohort attribution — so that
    // trialToSubConvPercent in each row compares conversions against the same
    // trial batch, not against unrelated trials that started in the payment month).
    for (const [uid, at] of firstPaidAt) {
      if (!isAllowed(uid)) continue;
      const tAt = trialStartAt.get(uid);
      if (tAt && tAt <= at && inRange(tAt)) {
        addOnce("convertedFromTrial", periodKey(tAt), uid);
      }
      if (!inRange(at)) continue;
      const p = periodKey(at);
      addOnce("totalSubscribed", p, uid);
      // PhonePe conversion keeps billing the SAME (trial-flagged) sub row, so the
      // paid branch above never sees it — count subActive from the latest sub here.
      if (!paidSubUsers.has(uid)) {
        const history = subsByUser.get(uid) ?? [];
        const latest = history[history.length - 1];
        if (latest && latest.endsAt && latest.endsAt > now &&
            (latest.status === "ACTIVE" || latest.status === "CANCELED")) {
          addOnce("subActive", p, uid);
        }
      }
    }

    // Renewals: 2nd+ successful paid charge on the SAME subscriptionId.
    // Charges before the window still count toward the sequence, so a July renewal
    // of a June subscription is correctly detected.
    const txCountBySub = new Map<string, number>();
    for (const t of txs) {
      if (t.trialPlanId || !t.planId || !t.subscriptionId) continue;
      const n = (txCountBySub.get(t.subscriptionId) ?? 0) + 1;
      txCountBySub.set(t.subscriptionId, n);
      if (n >= 2 && isAllowed(t.userId) && inRange(t.createdAt)) {
        addOnce("renewedSubs", periodKey(t.createdAt), t.userId);
      }
    }

    // ── Step 5: Build period rows + overall ───────────────────────────────────
    const rows: LifecycleRow[] = Array.from(periodCounters.entries())
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([p, c]) => buildRow(p, c));

    // Overall = sum of all counters, percentages recomputed
    const overall = zeroCounters();
    for (const c of periodCounters.values()) {
      for (const key of Object.keys(overall) as (keyof typeof overall)[]) {
        overall[key] += c[key];
      }
    }

    return {
      overall: buildRow("Overall", overall),
      rows,
    };
  });

  // ── Biz-Fin Summary ──────────────────────────────────────────────────────────

  interface BizFinRow {
    period: string;
    activeTotal: number;
    activePaidSubs: number;
    activeTrials: number;
    mrrRupees: number;
    totalRegistered: number;
    arpuRupees: number;
    arppuRupees: number;
    grossRevenueRupees: number;
    netRevenueRupees: number;
  }

  type BizFinSqlRow = {
    period_key: string;
    active_all: number;
    active_paid: number;
    active_trial: number;
    mrr_rupees: number;
    gross_rupees: number;
    refunded_rupees: number;
  };

  /**
   * GET /api/v1/subscription/admin/analytics/biz-fin
   *
   * Calendar-period view of subscription and revenue health.
   * Snapshot metrics (subs, MRR) reflect state at the end of each period.
   * Revenue metrics reflect transactions that occurred within the period.
   *
   * Filters: startDate, endDate, period (daily|monthly)
   */
  app.get("/analytics/biz-fin", {
    schema: {
      querystring: z.object({
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        period: z.enum(["daily", "monthly"]).optional().default("monthly"),
      }),
    },
  }, async (request) => {
    const { startDate, endDate, period = "monthly" } =
      request.query as { startDate?: string; endDate?: string; period: "daily" | "monthly" };

    const config = loadConfig();
    const serviceToken = config.SERVICE_AUTH_TOKEN ?? "";

    // endDate is INCLUSIVE (same as /admin/all-transactions) — the full endDate day counts
    const end = endDate
      ? new Date(`${endDate}T23:59:59.999+05:30`)
      : new Date();
    const start = startDate
      ? new Date(`${startDate}T00:00:00.000+05:30`)
      : new Date(end.getTime() - 365 * 24 * 60 * 60 * 1000);

    const periodFmt = period === "monthly" ? "YYYY-MM" : "YYYY-MM-DD";
    const periodTrunc = period === "monthly" ? "month" : "day";
    const periodInterval = period === "monthly" ? "1 month" : "1 day";
    const periodEnd = period === "monthly"
      ? `gs + INTERVAL '1 month' - INTERVAL '1 millisecond'`
      : `gs + INTERVAL '1 day' - INTERVAL '1 millisecond'`;

    // ── Run SQL + AuthService fetch in parallel ────────────────────────────────
    const [sqlRows, regData] = await Promise.all([
      prisma.$queryRawUnsafe<BizFinSqlRow[]>(`
        WITH periods AS (
          SELECT
            gs AS p_start,
            ${periodEnd} AS p_end,
            TO_CHAR(gs AT TIME ZONE 'Asia/Kolkata', '${periodFmt}') AS period_key
          FROM generate_series(
            DATE_TRUNC('${periodTrunc}', $1::timestamptz AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata',
            DATE_TRUNC('${periodTrunc}', $2::timestamptz AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata',
            INTERVAL '${periodInterval}'
          ) gs
        ),
        active_subs AS (
          SELECT
            p.period_key,
            p.p_end,
            us."userId",
            us."planId",
            us."trialPlanId",
            us."status",
            us."provider",
            sp."pricePaise",
            sp."durationDays",
            -- Paid = dedicated paid sub, OR a trial-flagged sub whose user has a successful
            -- paid Transaction by this period's end. PhonePe converts trial→paid by
            -- re-billing the SAME record (trialPlanId stays set), so the transaction
            -- is the only reliable paid signal for those users.
            (
              (us."trialPlanId" IS NULL AND us."planId" IS NOT NULL)
              OR EXISTS (
                SELECT 1 FROM "Transaction" t
                WHERE t."userId" = us."userId"
                  AND t."status" = 'SUCCESS'
                  AND t."trialPlanId" IS NULL
                  AND t."planId" IS NOT NULL
                  AND t."createdAt" <= p.p_end
              )
            ) AS is_paid,
            ROW_NUMBER() OVER (
              PARTITION BY p.period_key, us."userId"
              ORDER BY us."endsAt" DESC
            ) AS rn
          FROM periods p
          JOIN "UserSubscription" us
            ON us."status" IN ('ACTIVE', 'TRIAL', 'CANCELED', 'PAUSED')
            AND us."startsAt" <= p.p_end
            AND us."endsAt" > p.p_end
          LEFT JOIN "SubscriptionPlan" sp ON sp.id = us."planId"
        ),
        deduped AS (
          SELECT * FROM active_subs WHERE rn = 1
        ),
        -- Razorpay ONLY: real recurring price comes from the user's actual charges.
        -- The plan row was edited in place, so pricePaise/durationDays no longer match
        -- what legacy Razorpay subscribers pay (Rs99 billed MONTHLY per Razorpay,
        -- regardless of the plan row's name/duration). PhonePe keeps plan pricing.
        sub_mrr AS (
          SELECT
            d.*,
            lt.amount_paise AS last_amount_paise,
            lt.created_at   AS last_charge_at,
            pt.created_at   AS prev_charge_at
          FROM deduped d
          LEFT JOIN LATERAL (
            SELECT t."amountPaise" AS amount_paise, t."createdAt" AS created_at, t."subscriptionId" AS sub_id
            FROM "Transaction" t
            WHERE d."provider" = 'razorpay'
              AND t."userId" = d."userId"
              AND t."status" = 'SUCCESS'
              AND t."trialPlanId" IS NULL
              AND t."planId" IS NOT NULL
              AND t."createdAt" <= d.p_end
            ORDER BY t."createdAt" DESC
            LIMIT 1
          ) lt ON true
          LEFT JOIN LATERAL (
            SELECT t."createdAt" AS created_at
            FROM "Transaction" t
            WHERE t."userId" = d."userId"
              AND t."status" = 'SUCCESS'
              AND t."trialPlanId" IS NULL
              AND t."planId" IS NOT NULL
              AND t."subscriptionId" IS NOT DISTINCT FROM lt.sub_id
              AND t."createdAt" < lt.created_at
            ORDER BY t."createdAt" DESC
            LIMIT 1
          ) pt ON true
        ),
        period_subs AS (
          SELECT
            period_key,
            COUNT(*)::int                                                              AS active_all,
            COUNT(*) FILTER (WHERE is_paid)::int                                       AS active_paid,
            COUNT(*) FILTER (WHERE NOT is_paid AND "trialPlanId" IS NOT NULL)::int     AS active_trial,
            -- MRR excludes CANCELED subs: they will not renew so should not count as recurring revenue.
            -- Razorpay: latest real charge amount normalized by the OBSERVED billing gap
            -- (fallback: 30 days — Razorpay bills monthly). PhonePe: plan-table pricing.
            COALESCE(SUM(
              CASE WHEN "provider" = 'razorpay' AND last_amount_paise IS NOT NULL THEN
                last_amount_paise::numeric / 100.0 * 30.0
                / GREATEST(COALESCE(
                    EXTRACT(EPOCH FROM (last_charge_at - prev_charge_at)) / 86400.0, 30
                  ), 1)
              ELSE
                "pricePaise"::numeric / 100.0 * (30.0 / NULLIF("durationDays", 0))
              END
            ) FILTER (WHERE is_paid AND "status" != 'CANCELED'), 0)                    AS mrr_rupees
          FROM sub_mrr
          GROUP BY period_key
        ),
        period_revenue AS (
          SELECT
            TO_CHAR("createdAt" AT TIME ZONE 'Asia/Kolkata', '${periodFmt}') AS period_key,
            COALESCE(SUM("amountPaise") FILTER (WHERE "status" = 'SUCCESS'),  0)::numeric / 100.0 AS gross_rupees,
            COALESCE(SUM("amountPaise") FILTER (WHERE "status" = 'REFUNDED'), 0)::numeric / 100.0 AS refunded_rupees
          FROM "Transaction"
          WHERE "createdAt" >= $1 AND "createdAt" < $2
          GROUP BY 1
        )
        SELECT
          p.period_key,
          COALESCE(ps.active_all,   0)::int     AS active_all,
          COALESCE(ps.active_paid,  0)::int     AS active_paid,
          COALESCE(ps.active_trial, 0)::int     AS active_trial,
          COALESCE(ps.mrr_rupees,   0)::numeric AS mrr_rupees,
          COALESCE(r.gross_rupees,    0)::numeric AS gross_rupees,
          COALESCE(r.refunded_rupees, 0)::numeric AS refunded_rupees
        FROM periods p
        LEFT JOIN period_subs ps ON ps.period_key = p.period_key
        LEFT JOIN period_revenue r ON r.period_key = p.period_key
        ORDER BY p.period_key DESC
      `, start, end),

      (() => {
        const regParams = new URLSearchParams({ period });
        if (startDate) regParams.set("startDate", startDate);
        if (endDate) regParams.set("endDate", endDate);
        return fetch(
          `${config.AUTH_SERVICE_URL}/internal/analytics/registration-counts?${regParams}`,
          { headers: { "x-service-token": serviceToken } }
        ).then(async (res) => {
          if (!res.ok) {
            request.log.warn({ status: res.status }, "biz-fin: AuthService registration-counts failed");
            return { cohorts: [] as { period: string; count: number }[] };
          }
          return res.json() as Promise<{ cohorts: { period: string; count: number }[] }>;
        }).catch((err) => {
          request.log.warn({ err }, "biz-fin: AuthService registration-counts error");
          return { cohorts: [] as { period: string; count: number }[] };
        });
      })(),
    ]);

    // ── Per-period registration counts (not cumulative) ────────────────────────
    const regByPeriod = new Map<string, number>();
    for (const cohort of regData.cohorts) {
      regByPeriod.set(cohort.period, cohort.count);
    }

    // ── Build period rows ──────────────────────────────────────────────────────
    const rows: BizFinRow[] = sqlRows.map((r) => {
      const totalReg = regByPeriod.get(r.period_key) ?? 0;
      const mrr = Number(r.mrr_rupees);
      const gross = Number(r.gross_rupees);
      const refunded = Number(r.refunded_rupees);
      const paidSubs = Number(r.active_paid);
      return {
        period: r.period_key,
        activeTotal: Number(r.active_all),
        activePaidSubs: paidSubs,
        activeTrials: Number(r.active_trial),
        mrrRupees: +mrr.toFixed(2),
        totalRegistered: totalReg,
        arpuRupees: totalReg > 0 ? +(mrr / totalReg).toFixed(2) : 0,
        arppuRupees: paidSubs > 0 ? +(mrr / paidSubs).toFixed(2) : 0,
        grossRevenueRupees: +gross.toFixed(2),
        netRevenueRupees: +(gross - refunded).toFixed(2),
      };
    });

    // ── Overall row — snapshot fields from latest period, revenue+registrations summed ──
    // rows[0] is most recent because SQL uses ORDER BY period_key DESC
    const last = rows[0];
    const totalGross = rows.reduce((s, r) => s + r.grossRevenueRupees, 0);
    const totalNet = rows.reduce((s, r) => s + r.netRevenueRupees, 0);
    const totalReg = rows.reduce((s, r) => s + r.totalRegistered, 0);
    const overallMrr = last?.mrrRupees ?? 0;
    const overallPaid = last?.activePaidSubs ?? 0;

    const overall: BizFinRow = {
      period: "Overall",
      activeTotal: last?.activeTotal ?? 0,
      activePaidSubs: overallPaid,
      activeTrials: last?.activeTrials ?? 0,
      mrrRupees: overallMrr,
      totalRegistered: totalReg,
      arpuRupees: totalReg > 0 ? +(overallMrr / totalReg).toFixed(2) : 0,
      arppuRupees: overallPaid > 0 ? +(overallMrr / overallPaid).toFixed(2) : 0,
      grossRevenueRupees: +totalGross.toFixed(2),
      netRevenueRupees: +totalNet.toFixed(2),
    };

    return {
      range: { startDate: start.toISOString(), endDate: end.toISOString() },
      overall,
      rows,
    };
  });

  // ── PostHog Funnels ──────────────────────────────────────────────────────────

  const FUNNEL_CACHE_TTL = 300; // 5 minutes

  /**
   * GET /api/v1/subscription/admin/analytics/funnels/:funnelId
   *
   * Pulls a single funnel from PostHog Query API, caches result 5 min in Redis.
   *
   * Params:  funnelId — one of: activation, paywall-conversion, video-engagement,
   *                              episode-paywall, audio-engagement, search
   * Query:   startDate  YYYY-MM-DD (IST)
   *          endDate    YYYY-MM-DD (IST, exclusive)
   *          platform   all | android | ios  (default: all)
   */
  app.get("/analytics/funnels/:funnelId", {
    schema: {
      params: z.object({
        funnelId: z.enum(FUNNEL_IDS as [string, ...string[]]),
      }),
      querystring: z.object({
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        platform: z.enum(["all", "android", "ios"]).optional().default("all"),
      }),
    },
  }, async (request, reply) => {
    const { funnelId } = request.params as { funnelId: string };
    const { startDate, endDate, platform = "all" } =
      request.query as { startDate?: string; endDate?: string; platform: "all" | "android" | "ios" };

    const funnel = FUNNELS[funnelId];
    if (!funnel) return reply.code(404).send({ error: "Funnel not found" });

    const dateFrom = startDate ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const dateTo = endDate ?? new Date().toISOString().slice(0, 10);

    const cacheKey = `posthog:funnel:${funnelId}:${dateFrom}:${dateTo}:${platform}`;

    const redis = getRedis();
    const cached = await redis.get(cacheKey).catch(() => null);
    if (cached) {
      return JSON.parse(cached);
    }

    try {
      const steps = await queryPostHogFunnel({ funnel, dateFrom, dateTo, platform });

      const result = {
        funnelId,
        funnelName: funnel.name,
        conversionWindow: `${funnel.conversionWindowInterval}${funnel.conversionWindowUnit}`,
        dateFrom,
        dateTo,
        platform,
        lastRefreshedAt: new Date().toISOString(),
        steps,
      };

      await redis.set(cacheKey, JSON.stringify(result), "EX", FUNNEL_CACHE_TTL).catch(() => {});

      return result;
    } catch (err: any) {
      request.log.error({ err }, "PostHog funnel query failed");
      return reply.code(502).send({ error: "PostHog query failed", detail: err.message });
    }
  });

  /**
   * GET /api/v1/subscription/admin/analytics/funnels
   * Lists available funnel IDs and names.
   */
  app.get("/analytics/funnels", {}, async () => {
    return {
      funnels: FUNNEL_IDS.map((id) => ({
        id,
        name: FUNNELS[id].name,
        steps: FUNNELS[id].steps.length,
        conversionWindow: `${FUNNELS[id].conversionWindowInterval}${FUNNELS[id].conversionWindowUnit}`,
      })),
    };
  });
}
