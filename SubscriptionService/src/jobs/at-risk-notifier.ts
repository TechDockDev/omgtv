import { PrismaClient } from "@prisma/client";
import { NotificationClient } from "../clients/notification-client";
import { loadConfig } from "../config";

const EXPIRY_TRIGGERS = [
  {
    key: "EXPIRY_1D",
    days: 1,
    title: "Last Day to Renew",
    body: "Today is your last day! Renew your subscription to keep watching.",
  },
  {
    key: "EXPIRY_3D",
    days: 3,
    title: "Subscription Expiring in 3 Days",
    body: "Only 3 days left! Renew your subscription to continue watching.",
  },
  {
    key: "EXPIRY_7D",
    days: 7,
    title: "Subscription Expiring Soon",
    body: "Your subscription expires in 7 days. Renew now to keep watching!",
  },
] as const;

const INACTIVITY_TRIGGERS = [
  {
    key: "INACTIVE_7D",
    minDays: 7,
    maxDays: 13,
    title: "We Miss You!",
    body: "You haven't watched anything in a week. Come back and continue where you left off!",
  },
  {
    key: "INACTIVE_14D",
    minDays: 14,
    maxDays: null,
    title: "Come Back!",
    body: "Your subscription is still active. Lots of new content is waiting for you!",
  },
] as const;

const FREE_USER_TRIGGERS = [
  {
    key: "FREE_REMINDER_1",
    daysAfterPrev: 0,
    title: "Start Your Free Trial Today!",
    body: "Get unlimited access to all content. Start your free trial now!",
  },
  {
    key: "FREE_REMINDER_2",
    daysAfterPrev: 7,
    title: "Don't Miss Out!",
    body: "Your friends are watching. Subscribe now and join them!",
  },
  {
    key: "FREE_REMINDER_3",
    daysAfterPrev: 14, // 21 days after reminder 1
    title: "Last Chance — Special Offer Inside!",
    body: "Get full access to all shows and episodes. Subscribe today!",
  },
] as const;

const PUSH_BATCH_SIZE = 50;
const PUSH_BATCH_DELAY_MS = 500;
const DEDUP_HOURS = 20;

async function sendInBatches(
  userIds: string[],
  title: string,
  body: string,
  data: Record<string, string>,
  client: NotificationClient
) {
  for (let i = 0; i < userIds.length; i += PUSH_BATCH_SIZE) {
    const batch = userIds.slice(i, i + PUSH_BATCH_SIZE);
    await Promise.allSettled(batch.map((id) => client.sendPush(id, title, body, data)));
    if (i + PUSH_BATCH_SIZE < userIds.length) {
      await new Promise((r) => setTimeout(r, PUSH_BATCH_DELAY_MS));
    }
  }
}

async function runAtRiskNotifier(prisma: PrismaClient) {
  const config = loadConfig();
  const notificationClient = new NotificationClient();
  const now = new Date();

  // ── Expiry notifications ─────────────────────────────────────────────────
  for (const trigger of EXPIRY_TRIGGERS) {
    const windowStart = new Date(now.getTime() + (trigger.days - 0.5) * 86400_000);
    const windowEnd = new Date(now.getTime() + (trigger.days + 0.5) * 86400_000);

    const expiring = await prisma.userSubscription.findMany({
      where: { status: "CANCELED", endsAt: { gte: windowStart, lte: windowEnd } },
      distinct: ["userId"],
      select: { userId: true },
    });

    if (expiring.length === 0) continue;

    const userIds = expiring.map((s) => s.userId);
    const history = await notificationClient.getBulkHistory(userIds, trigger.key);

    const toNotify = userIds.filter((id) => {
      const h = history[id];
      if (!h?.lastSentAt) return true;
      return (now.getTime() - new Date(h.lastSentAt).getTime()) / 3_600_000 >= DEDUP_HOURS;
    });

    await sendInBatches(toNotify, trigger.title, trigger.body, { type: trigger.key, trigger: trigger.key }, notificationClient);
  }

  // ── Inactivity notifications ─────────────────────────────────────────────
  const activeSubscriptions = await prisma.userSubscription.findMany({
    where: { status: "ACTIVE", endsAt: { gt: now } },
    distinct: ["userId"],
    select: { userId: true },
  });

  if (activeSubscriptions.length > 0) {
    const activeUserIds = activeSubscriptions.map((s) => s.userId);

    const activityRes = await fetch(
      `${config.ENGAGEMENT_SERVICE_URL}/internal/users/at-risk-activity`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.SERVICE_AUTH_TOKEN ? { "x-service-token": config.SERVICE_AUTH_TOKEN } : {}),
        },
        body: JSON.stringify({ userIds: activeUserIds }),
      }
    )
      .then((r) => (r.ok ? (r.json() as Promise<{ activity: Record<string, any> }>) : { activity: {} }))
      .catch(() => ({ activity: {} }));

    const activityMap: Record<string, any> = (activityRes as any).activity ?? {};

    for (const trigger of INACTIVITY_TRIGGERS) {
      const matchedIds = activeUserIds.filter((id) => {
        const days = activityMap[id]?.daysSinceActive ?? null;
        if (trigger.maxDays === null) return days === null || days >= trigger.minDays;
        return days !== null && days >= trigger.minDays && days < trigger.maxDays;
      });

      if (matchedIds.length === 0) continue;

      const history = await notificationClient.getBulkHistory(matchedIds, trigger.key);

      const toNotify = matchedIds.filter((id) => {
        const h = history[id];
        if (!h?.lastSentAt) return true;
        return (now.getTime() - new Date(h.lastSentAt).getTime()) / 3_600_000 >= DEDUP_HOURS;
      });

      await sendInBatches(toNotify, trigger.title, trigger.body, { type: trigger.key, trigger: trigger.key }, notificationClient);
    }
  }

  // ── Free user reminders ──────────────────────────────────────────────────
  // Get all registered user IDs from UserService (paginated, max 5000 per call)
  const allUserIds: string[] = [];
  let searchOffset = 0;
  while (true) {
    const res = await fetch(`${config.USER_SERVICE_URL}/internal/users/search`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.SERVICE_AUTH_TOKEN ? { "x-service-token": config.SERVICE_AUTH_TOKEN } : {}),
      },
      body: JSON.stringify({ limit: 5000, offset: searchOffset }),
    })
      .then((r) => (r.ok ? (r.json() as Promise<{ userIds: string[] }>) : { userIds: [] }))
      .catch(() => ({ userIds: [] }));

    const batch = (res as any).userIds ?? [];
    allUserIds.push(...batch);
    if (batch.length < 5000) break;
    searchOffset += 5000;
  }

  if (allUserIds.length === 0) return;

  // Users who have NEVER had any subscription or trial
  const subscribedRows = await prisma.userSubscription.findMany({
    select: { userId: true },
    distinct: ["userId"],
  });
  const subscribedSet = new Set(subscribedRows.map((s) => s.userId));
  const freeUserIds = allUserIds.filter((id) => !subscribedSet.has(id));

  if (freeUserIds.length === 0) return;

  // Fetch history for all 3 reminder keys in parallel
  const [h1, h2, h3] = await Promise.all(
    FREE_USER_TRIGGERS.map((t) => notificationClient.getBulkHistory(freeUserIds, t.key))
  );
  const histories = [h1, h2, h3];

  // Each reminder fires only when the previous one was sent >= daysAfterPrev days ago
  for (let i = 0; i < FREE_USER_TRIGGERS.length; i++) {
    const trigger = FREE_USER_TRIGGERS[i];
    const prevHistory = i === 0 ? null : histories[i - 1];
    const currHistory = histories[i];

    const toSend = freeUserIds.filter((id) => {
      if (currHistory[id]?.lastSentAt) return false; // already received this reminder
      if (i === 0) return true; // reminder 1: send to everyone who hasn't received it
      const prevSent = prevHistory![id]?.lastSentAt;
      if (!prevSent) return false; // hasn't received previous reminder yet
      const daysSincePrev = (now.getTime() - new Date(prevSent).getTime()) / 86_400_000;
      return daysSincePrev >= trigger.daysAfterPrev;
    });

    if (toSend.length > 0) {
      await sendInBatches(toSend, trigger.title, trigger.body, { type: trigger.key, trigger: trigger.key }, notificationClient);
    }
  }
}

export function startAtRiskNotifier(prisma: PrismaClient) {
  const run = () => {
    runAtRiskNotifier(prisma).catch((err) =>
      console.error("[AtRiskNotifier] Job failed:", err)
    );
  };

  // Delay first run by 2 minutes to let the server fully start
  setTimeout(run, 2 * 60 * 1000);

  // Re-run every 24 hours
  setInterval(run, 24 * 60 * 60 * 1000);
}
