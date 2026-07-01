import { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPrisma } from "../../lib/prisma";
import { loadConfig } from "../../config";

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
  subChurned: number;
  subChurnPercent: number;
  reactivated: number;
  recoveryPercent: number;
  razorpayUsers: number;
  phonePeUsers: number;
  razorpayPercent: number;
  phonePePercent: number;
}

interface UserSubRow {
  userId: string;
  had_trial: boolean | string;
  had_paid: boolean | string;
  trial_status: string | null;
  trial_ends_at: Date | null;
  paid_status: string | null;
  paid_ends_at: Date | null;
  provider: string | null;
  is_reactivated: boolean | string;
}

const bool = (v: any): boolean => v === true || v === "t";

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
   *   rows    — one row per cohort period
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

    // ── Step 1: Get registration cohorts from AuthService ──────────────────────
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

    if (!cohorts.length) return { overall: buildRow("Overall", zeroCounters()), rows: [] };

    // ── Step 2: Apply platform filter via UserService ──────────────────────────
    let cohortsFinal = cohorts;

    if (platform !== "all") {
      const allIdsForPlatformCheck = cohorts.flatMap((c) => c.userIds);
      try {
        const res = await fetch(
          `${config.USER_SERVICE_URL}/internal/analytics/filter-by-platform`,
          {
            method: "POST",
            headers: { "content-type": "application/json", "x-service-token": serviceToken },
            body: JSON.stringify({ authIds: allIdsForPlatformCheck, os: platform }),
          }
        );
        if (!res.ok) {
          request.log.warn({ status: res.status }, "UserService filter-by-platform failed — skipping platform filter");
        } else {
          const data = await res.json() as { authIds: string[] };
          const matchedSet = new Set(data.authIds);
          cohortsFinal = cohorts.map((c) => ({
            ...c,
            userIds: c.userIds.filter((id) => matchedSet.has(id)),
            count: 0,
          })).map((c) => ({ ...c, count: c.userIds.length }))
            .filter((c) => c.count > 0);
        }
      } catch (err) {
        request.log.warn(err, "UserService filter-by-platform error — skipping platform filter");
      }
    }

    if (!cohortsFinal.length) return { overall: buildRow("Overall", zeroCounters()), rows: [] };

    // ── Step 3: Build userId → period map ─────────────────────────────────────
    const periodMap = new Map<string, string>();
    for (const c of cohortsFinal) {
      for (const uid of c.userIds) {
        periodMap.set(uid, c.period);
      }
    }
    const allUserIds = Array.from(periodMap.keys());

    // ── Step 4: Single SQL — per-user subscription status flags ───────────────
    const now = new Date();

    const subRows = await prisma.$queryRaw<UserSubRow[]>`
      WITH LatestTrial AS (
        SELECT DISTINCT ON ("userId")
          "userId", "status", "endsAt", "provider"
        FROM "UserSubscription"
        WHERE "trialPlanId" IS NOT NULL
          AND "status" != 'PENDING'
          AND "userId" = ANY(${allUserIds})
        ORDER BY "userId", "createdAt" DESC
      ),
      LatestPaid AS (
        SELECT DISTINCT ON ("userId")
          "userId", "status", "endsAt", "provider"
        FROM "UserSubscription"
        WHERE "trialPlanId" IS NULL AND "planId" IS NOT NULL
          AND "status" != 'PENDING'
          AND "userId" = ANY(${allUserIds})
        ORDER BY "userId", "createdAt" DESC
      ),
      HadTrial AS (
        SELECT DISTINCT "userId"
        FROM "UserSubscription"
        WHERE "trialPlanId" IS NOT NULL
          AND "userId" = ANY(${allUserIds})
      ),
      HadPaid AS (
        SELECT DISTINCT "userId"
        FROM "UserSubscription"
        WHERE "trialPlanId" IS NULL AND "planId" IS NOT NULL
          AND "userId" = ANY(${allUserIds})
      ),
      Reactivated AS (
        SELECT DISTINCT us1."userId"
        FROM "UserSubscription" us1
        WHERE us1."userId" = ANY(${allUserIds})
          AND us1."status" = 'ACTIVE'
          AND us1."planId" IS NOT NULL
          AND us1."trialPlanId" IS NULL
          AND us1."endsAt" > ${now}
          AND EXISTS (
            SELECT 1 FROM "UserSubscription" us2
            WHERE us2."userId" = us1."userId"
              AND us2."planId" IS NOT NULL
              AND us2."trialPlanId" IS NULL
              AND us2."status" IN ('CANCELED', 'EXPIRED')
              AND us2."createdAt" < us1."createdAt"
          )
      ),
      ActiveUsers AS (
        SELECT "userId" FROM HadTrial
        UNION
        SELECT "userId" FROM HadPaid
      )
      SELECT
        au."userId"                                             AS "userId",
        (ht."userId" IS NOT NULL)                             AS had_trial,
        (hp."userId" IS NOT NULL)                             AS had_paid,
        lt."status"                                           AS trial_status,
        lt."endsAt"                                           AS trial_ends_at,
        lp."status"                                           AS paid_status,
        lp."endsAt"                                           AS paid_ends_at,
        COALESCE(lp."provider", lt."provider")                AS provider,
        (r."userId" IS NOT NULL)                              AS is_reactivated
      FROM ActiveUsers au
      LEFT JOIN HadTrial ht  ON au."userId" = ht."userId"
      LEFT JOIN HadPaid  hp  ON au."userId" = hp."userId"
      LEFT JOIN LatestTrial lt ON au."userId" = lt."userId"
      LEFT JOIN LatestPaid  lp ON au."userId" = lp."userId"
      LEFT JOIN Reactivated  r ON au."userId" = r."userId"
    `;

    // ── Step 5: Aggregate per cohort period in TypeScript ─────────────────────
    const subUserSet = new Set(subRows.map((r) => r.userId));

    const periodCounters = new Map<string, ReturnType<typeof zeroCounters>>();
    for (const c of cohortsFinal) {
      periodCounters.set(c.period, { ...zeroCounters(), registrations: c.count });
    }

    // Free users: registered users with zero subscription activity
    for (const c of cohortsFinal) {
      const counter = periodCounters.get(c.period)!;
      for (const uid of c.userIds) {
        if (!subUserSet.has(uid)) counter.freeUsers++;
      }
    }

    // Per-user subscription metrics
    for (const row of subRows) {
      const cohortPeriod = periodMap.get(row.userId);
      if (!cohortPeriod) continue;
      const counter = periodCounters.get(cohortPeriod);
      if (!counter) continue;

      const hadTrial = bool(row.had_trial);
      const hadPaid = bool(row.had_paid);
      const trialEndsAt = row.trial_ends_at ? new Date(row.trial_ends_at) : null;
      const paidEndsAt = row.paid_ends_at ? new Date(row.paid_ends_at) : null;

      if (hadTrial) counter.trialStarted++;

      if (row.trial_status === "TRIAL" || row.trial_status === "ACTIVE") {
        if (trialEndsAt && trialEndsAt > now) counter.trialActive++;
      }
      if (row.trial_status === "CANCELED") counter.trialCancelled++;
      if (row.trial_status === "EXPIRED") counter.trialExpired++;

      if (hadTrial && hadPaid) counter.convertedFromTrial++;

      if (hadPaid) counter.totalSubscribed++;
      if (row.paid_status === "ACTIVE" && paidEndsAt && paidEndsAt > now) counter.subActive++;
      if (row.paid_status === "CANCELED") counter.subCancelled++;
      if (row.paid_status === "EXPIRED") counter.subExpired++;
      if (row.paid_status === "CANCELED" || row.paid_status === "EXPIRED") counter.subChurned++;

      if (bool(row.is_reactivated)) counter.reactivated++;

      if (row.provider === "razorpay") counter.razorpayUsers++;
      if (row.provider === "phonepe") counter.phonePeUsers++;
    }

    // ── Step 6: Build period rows + overall ───────────────────────────────────
    const rows: LifecycleRow[] = Array.from(periodCounters.entries())
      .sort(([a], [b]) => a.localeCompare(b))
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
  }, async (request, reply) => {
    const { startDate, endDate, period = "monthly" } =
      request.query as { startDate?: string; endDate?: string; period: "daily" | "monthly" };

    const config = loadConfig();
    const serviceToken = config.SERVICE_AUTH_TOKEN ?? "";

    const end = endDate
      ? new Date(`${endDate}T23:59:59.999+05:30`)
      : new Date();
    const start = startDate
      ? new Date(`${startDate}T00:00:00.000+05:30`)
      : new Date(end.getTime() - 365 * 24 * 60 * 60 * 1000);

    const periodFmt = period === "monthly" ? "YYYY-MM" : "YYYY-MM-DD";
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
            DATE_TRUNC('${period}', $1::timestamptz AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata',
            DATE_TRUNC('${period}', $2::timestamptz AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata',
            INTERVAL '${periodInterval}'
          ) gs
        ),
        active_subs AS (
          SELECT
            p.period_key,
            us."userId",
            us."planId",
            us."trialPlanId",
            sp."pricePaise",
            sp."durationDays",
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
        period_subs AS (
          SELECT
            period_key,
            COUNT(*)::int                                                                  AS active_all,
            COUNT(*) FILTER (WHERE "planId" IS NOT NULL AND "trialPlanId" IS NULL)::int   AS active_paid,
            COUNT(*) FILTER (WHERE "trialPlanId" IS NOT NULL)::int                        AS active_trial,
            COALESCE(SUM(
              "pricePaise"::numeric / 100.0 * (30.0 / NULLIF("durationDays", 0))
            ) FILTER (WHERE "planId" IS NOT NULL AND "trialPlanId" IS NULL), 0)           AS mrr_rupees
          FROM deduped
          GROUP BY period_key
        ),
        period_revenue AS (
          SELECT
            TO_CHAR("createdAt" AT TIME ZONE 'Asia/Kolkata', '${periodFmt}') AS period_key,
            COALESCE(SUM("amountPaise") FILTER (WHERE "status" = 'SUCCESS'),  0)::numeric / 100.0 AS gross_rupees,
            COALESCE(SUM("amountPaise") FILTER (WHERE "status" = 'REFUNDED'), 0)::numeric / 100.0 AS refunded_rupees
          FROM "Transaction"
          WHERE "createdAt" >= $1 AND "createdAt" <= $2
            AND "planId" IS NOT NULL
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
        ORDER BY p.period_key
      `, start, end),

      fetch(
        `${config.AUTH_SERVICE_URL}/internal/analytics/registration-counts?period=${period}`,
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
      }),
    ]);

    // ── Accumulate cumulative registrations ────────────────────────────────────
    // AuthService returns cohorts from 2020-01-01 onward (no startDate sent).
    // We accumulate a running total so each period row knows total registered users
    // as of that period end.
    const sortedCohorts = regData.cohorts.sort((a, b) => a.period.localeCompare(b.period));
    let runningReg = 0;
    let cohortIdx = 0;

    const cumRegByPeriod = new Map<string, number>();
    const sortedPeriodKeys = sqlRows.map((r) => r.period_key).sort((a, b) => a.localeCompare(b));

    for (const pKey of sortedPeriodKeys) {
      while (cohortIdx < sortedCohorts.length && sortedCohorts[cohortIdx].period <= pKey) {
        runningReg += sortedCohorts[cohortIdx].count;
        cohortIdx++;
      }
      cumRegByPeriod.set(pKey, runningReg);
    }

    // ── Build period rows ──────────────────────────────────────────────────────
    const rows: BizFinRow[] = sqlRows.map((r) => {
      const totalReg = cumRegByPeriod.get(r.period_key) ?? 0;
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

    // ── Overall row — snapshot fields from last period, revenue summed ─────────
    const last = rows[rows.length - 1];
    const totalGross = rows.reduce((s, r) => s + r.grossRevenueRupees, 0);
    const totalNet = rows.reduce((s, r) => s + r.netRevenueRupees, 0);
    const overallMrr = last?.mrrRupees ?? 0;
    const overallPaid = last?.activePaidSubs ?? 0;
    const overallReg = last?.totalRegistered ?? 0;

    const overall: BizFinRow = {
      period: "Overall",
      activeTotal: last?.activeTotal ?? 0,
      activePaidSubs: overallPaid,
      activeTrials: last?.activeTrials ?? 0,
      mrrRupees: overallMrr,
      totalRegistered: overallReg,
      arpuRupees: overallReg > 0 ? +(overallMrr / overallReg).toFixed(2) : 0,
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
}
