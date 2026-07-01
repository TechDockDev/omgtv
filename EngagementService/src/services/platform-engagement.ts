import { type PrismaClient } from "@prisma/client";
import { loadConfig } from "../config";

export interface PlatformPeriodRow {
  period: string;
  uniqueUsers: number;
  androidUsers: number;
  iosUsers: number;
  unknownUsers: number;
  appOpens: number;
  sessionsPerUser: number;
}

export interface PlatformOverallRow {
  period: "Overall";
  dau: number;
  wau: number;
  mau: number;
  stickiness: number;
  androidUsers: number;
  iosUsers: number;
  unknownUsers: number;
  totalAppOpens: number;
  sessionsPerUser: number;
}

export interface PlatformEngagementResult {
  range: { startDate: string; endDate: string };
  overall: PlatformOverallRow;
  rows: PlatformPeriodRow[];
}

type TupleRow = { period: string; identity: string; device_id: string };
type OpenRow  = { period: string; device_id: string; open_count: number };
type CountRow = { cnt: number };

async function queryIdentityTuples(
  prisma: PrismaClient,
  start: Date,
  end: Date,
  periodFmt: string
): Promise<TupleRow[]> {
  const fmt = `TO_CHAR("createdAt" AT TIME ZONE 'Asia/Kolkata', '${periodFmt}')`;
  return prisma.$queryRawUnsafe<TupleRow[]>(`
    SELECT DISTINCT
      ${fmt} AS period,
      COALESCE("userId", "guestId", "deviceId") AS identity,
      "deviceId" AS device_id
    FROM "AppEvent"
    WHERE "createdAt" >= $1 AND "createdAt" < $2
  `, start, end);
}

async function queryAppOpens(
  prisma: PrismaClient,
  start: Date,
  end: Date,
  periodFmt: string
): Promise<OpenRow[]> {
  const fmt = `TO_CHAR("createdAt" AT TIME ZONE 'Asia/Kolkata', '${periodFmt}')`;
  return prisma.$queryRawUnsafe<OpenRow[]>(`
    SELECT ${fmt} AS period, "deviceId" AS device_id, COUNT(*)::int AS open_count
    FROM "AppEvent"
    WHERE "eventType" = 'app_open' AND "createdAt" >= $1 AND "createdAt" < $2
    GROUP BY 1, 2
  `, start, end);
}

async function countDistinct(
  prisma: PrismaClient,
  start: Date,
  end: Date,
  platformDeviceIds: string[] | null
): Promise<number> {
  if (platformDeviceIds) {
    const rows = await prisma.$queryRawUnsafe<CountRow[]>(`
      SELECT COUNT(DISTINCT COALESCE("userId", "guestId", "deviceId"))::int AS cnt
      FROM "AppEvent"
      WHERE "createdAt" >= $1 AND "createdAt" < $2
        AND "deviceId" = ANY($3)
    `, start, end, platformDeviceIds);
    return Number(rows[0]?.cnt ?? 0);
  }
  const rows = await prisma.$queryRawUnsafe<CountRow[]>(`
    SELECT COUNT(DISTINCT COALESCE("userId", "guestId", "deviceId"))::int AS cnt
    FROM "AppEvent"
    WHERE "createdAt" >= $1 AND "createdAt" < $2
  `, start, end);
  return Number(rows[0]?.cnt ?? 0);
}

export async function getPlatformEngagement(params: {
  prisma: PrismaClient;
  start: Date;
  end: Date;
  periodType: "daily" | "monthly";
  platform?: "android" | "ios";
  log: { warn: (msg: string) => void };
}): Promise<PlatformEngagementResult> {
  const { prisma, start, end, periodType, platform, log } = params;
  const config = loadConfig();
  const tok = config.SERVICE_AUTH_TOKEN || "";
  const periodFmt = periodType === "daily" ? "YYYY-MM-DD" : "YYYY-MM";

  // ── Step 1: Identity tuples + app_open counts ─────────────────────────────
  const [tuples, opens] = await Promise.all([
    queryIdentityTuples(prisma, start, end, periodFmt),
    queryAppOpens(prisma, start, end, periodFmt),
  ]);

  // ── Step 2: Fetch device metadata (os) for all deviceIds ─────────────────
  const allDeviceIds = [...new Set(tuples.map((t) => t.device_id))];
  const deviceOs = new Map<string, string>(); // deviceId → lowercase os

  if (allDeviceIds.length > 0) {
    try {
      const res = await fetch(`${config.USER_SERVICE_URL}/internal/analytics/device-metadata`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-service-token": tok },
        body: JSON.stringify({ deviceIds: allDeviceIds.slice(0, 50000) }),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          devices: { deviceId: string; os: string | null }[];
        };
        for (const d of data.devices) {
          deviceOs.set(d.deviceId, (d.os ?? "unknown").toLowerCase());
        }
      }
    } catch (err) {
      log.warn(`platform-engagement: device-metadata failed: ${err}`);
    }
  }

  const getOs = (deviceId: string) => deviceOs.get(deviceId) ?? "unknown";

  // ── Step 3: Group by period (applying optional platform filter) ───────────
  const periodMap = new Map<string, {
    all: Set<string>;
    android: Set<string>;
    ios: Set<string>;
    unknown: Set<string>;
  }>();

  for (const t of tuples) {
    const os = getOs(t.device_id);
    if (platform && os !== platform) continue;

    if (!periodMap.has(t.period)) {
      periodMap.set(t.period, {
        all: new Set(), android: new Set(), ios: new Set(), unknown: new Set(),
      });
    }
    const g = periodMap.get(t.period)!;
    g.all.add(t.identity);
    if (os === "android") g.android.add(t.identity);
    else if (os === "ios") g.ios.add(t.identity);
    else g.unknown.add(t.identity);
  }

  const opensByPeriod = new Map<string, number>();
  for (const o of opens) {
    const os = getOs(o.device_id);
    if (platform && os !== platform) continue;
    opensByPeriod.set(o.period, (opensByPeriod.get(o.period) ?? 0) + Number(o.open_count));
  }

  const rows: PlatformPeriodRow[] = Array.from(periodMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, ids]) => {
      const u = ids.all.size;
      const ao = opensByPeriod.get(period) ?? 0;
      return {
        period,
        uniqueUsers: u,
        androidUsers: ids.android.size,
        iosUsers: ids.ios.size,
        unknownUsers: ids.unknown.size,
        appOpens: ao,
        sessionsPerUser: u > 0 ? Math.round((ao / u) * 10) / 10 : 0,
      };
    });

  // ── Step 4: Overall DAU / WAU / MAU ──────────────────────────────────────
  // Reuse already-fetched device metadata — build platform deviceId filter for SQL
  const platformDeviceIds: string[] | null = platform
    ? allDeviceIds.filter((id) => getOs(id) === platform)
    : null;

  const dauStart = new Date(end.getTime() - 1 * 24 * 60 * 60 * 1000);
  const wauStart = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [dau, wau, mau] = await Promise.all([
    countDistinct(prisma, dauStart, end, platformDeviceIds),
    countDistinct(prisma, wauStart, end, platformDeviceIds),
    countDistinct(prisma, start, end, platformDeviceIds),
  ]);

  const totalOpens = Array.from(opensByPeriod.values()).reduce((s, n) => s + n, 0);

  const overallAndroid = new Set<string>();
  const overallIos = new Set<string>();
  const overallUnknown = new Set<string>();
  for (const [, ids] of periodMap) {
    ids.android.forEach((id) => overallAndroid.add(id));
    ids.ios.forEach((id) => overallIos.add(id));
    ids.unknown.forEach((id) => overallUnknown.add(id));
  }

  const overall: PlatformOverallRow = {
    period: "Overall",
    dau,
    wau,
    mau,
    stickiness: mau > 0 ? Math.round((dau / mau) * 1000) / 10 : 0,
    androidUsers: overallAndroid.size,
    iosUsers: overallIos.size,
    unknownUsers: overallUnknown.size,
    totalAppOpens: totalOpens,
    sessionsPerUser: mau > 0 ? Math.round((totalOpens / mau) * 10) / 10 : 0,
  };

  return {
    range: { startDate: start.toISOString(), endDate: end.toISOString() },
    overall,
    rows,
  };
}
