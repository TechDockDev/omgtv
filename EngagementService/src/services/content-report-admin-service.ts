import type { PrismaClient, ReportStatus } from "@prisma/client";
import { NotificationClient } from "../clients/notification-client";
import { escapeHtml } from "../utils/html";

function buildResponseEmailHtml(params: {
  ticketId: string;
  reporterName: string;
  movieShowName: string;
  response: string;
  status: ReportStatus;
}): string {
  const { ticketId, reporterName, movieShowName, response, status } = params;
  return `
    <p>Hi ${escapeHtml(reporterName)},</p>
    <p>You have a response to your complaint regarding <strong>${escapeHtml(movieShowName)}</strong> (Ticket: <strong>${escapeHtml(ticketId)}</strong>):</p>
    <p style="padding:12px;border-left:3px solid #ccc;">${escapeHtml(response)}</p>
    <p>Current status: <strong>${escapeHtml(status)}</strong></p>
  `;
}

function pushCopyForStatus(status: ReportStatus): { title: string; body: string } {
  if (status === "RESOLVED") {
    return {
      title: "Your complaint has been resolved",
      body: "Check your email or the app for the full response.",
    };
  }
  return {
    title: "Your complaint has an update",
    body: "Check your email or the app for the full response.",
  };
}

export async function listContentReports(params: {
  prisma: PrismaClient;
  status?: ReportStatus;
  overdueOnly?: boolean;
  search?: string;
  page: number;
  limit: number;
}) {
  const { prisma, status, overdueOnly, search, page, limit } = params;
  const now = new Date();

  // Built as an AND list so an explicit `status` filter and `overdueOnly`
  // combine correctly instead of one silently overwriting the other.
  const conditions: Record<string, unknown>[] = [];
  if (status) conditions.push({ status });
  if (overdueOnly) {
    // Overdue never applies to RESOLVED tickets, regardless of any status filter above.
    conditions.push({ status: { not: "RESOLVED" as ReportStatus } }, { dueAt: { lt: now } });
  }
  const where: Record<string, unknown> = conditions.length ? { AND: conditions } : {};
  if (search) {
    where.OR = [
      { ticketId: { contains: search, mode: "insensitive" } },
      { reporterEmail: { contains: search, mode: "insensitive" } },
      { movieShowName: { contains: search, mode: "insensitive" } },
    ];
  }

  const [rows, total] = await Promise.all([
    prisma.contentReport.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.contentReport.count({ where }),
  ]);

  const items = rows.map((row) => ({
    ...row,
    isOverdue: row.status !== "RESOLVED" && row.dueAt < now,
    daysRemaining: Math.ceil((row.dueAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)),
  }));

  return {
    items,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };
}

export async function getContentReportById(params: { prisma: PrismaClient; id: string }) {
  const { prisma, id } = params;
  const row = await prisma.contentReport.findUnique({ where: { id } });
  if (!row) return null;

  const now = new Date();
  return {
    ...row,
    isOverdue: row.status !== "RESOLVED" && row.dueAt < now,
    daysRemaining: Math.ceil((row.dueAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)),
  };
}

export async function updateContentReport(params: {
  prisma: PrismaClient;
  id: string;
  status?: ReportStatus;
  response?: string;
  respondedBy?: string;
}) {
  const { prisma, id, status, response, respondedBy } = params;

  const existing = await prisma.contentReport.findUnique({ where: { id } });
  if (!existing) return null;

  const isNewResponse = typeof response === "string" && response.length > 0;

  const updated = await prisma.contentReport.update({
    where: { id },
    data: {
      ...(status ? { status } : {}),
      ...(isNewResponse
        ? { response, respondedAt: new Date(), respondedBy: respondedBy ?? null }
        : {}),
    },
  });

  if (isNewResponse) {
    const notificationClient = new NotificationClient();

    await notificationClient.sendEmail(
      updated.reporterEmail,
      `Response to your complaint ${updated.ticketId}`,
      buildResponseEmailHtml({
        ticketId: updated.ticketId,
        reporterName: updated.reporterName,
        movieShowName: updated.movieShowName,
        response: updated.response ?? "",
        status: updated.status,
      })
    );

    if (updated.userId) {
      const { title, body } = pushCopyForStatus(updated.status);
      await notificationClient.sendPush(updated.userId, title, body);
    }
  }

  const now = new Date();
  return {
    ...updated,
    isOverdue: updated.status !== "RESOLVED" && updated.dueAt < now,
    daysRemaining: Math.ceil((updated.dueAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)),
  };
}

function resolveIstMonthRange(month?: string): { start: Date; end: Date; month: string } {
  const now = new Date();
  const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const [year, mon] = month
    ? month.split("-").map((v) => parseInt(v, 10))
    : [istNow.getUTCFullYear(), istNow.getUTCMonth() + 1];

  const start = new Date(Date.UTC(year, mon - 1, 1, 0, 0, 0) - 5.5 * 60 * 60 * 1000);
  const end = new Date(Date.UTC(year, mon, 1, 0, 0, 0) - 5.5 * 60 * 60 * 1000);
  const label = `${year}-${String(mon).padStart(2, "0")}`;

  return { start, end, month: label };
}

export async function getContentReportStats(params: { prisma: PrismaClient; month?: string }) {
  const { prisma, month } = params;
  const { start, end, month: resolvedMonth } = resolveIstMonthRange(month);

  const [grouped, overdueComplaints] = await Promise.all([
    prisma.contentReport.groupBy({
      by: ["status"],
      where: { createdAt: { gte: start, lt: end } },
      _count: { _all: true },
    }),
    prisma.contentReport.count({
      where: {
        createdAt: { gte: start, lt: end },
        status: { not: "RESOLVED" as ReportStatus },
        dueAt: { lt: new Date() },
      },
    }),
  ]);

  let totalComplaints = 0;
  let resolvedComplaints = 0;
  let pendingComplaints = 0;

  for (const group of grouped) {
    const count = group._count._all;
    totalComplaints += count;
    if (group.status === "RESOLVED") {
      resolvedComplaints += count;
    } else {
      pendingComplaints += count;
    }
  }

  return {
    month: resolvedMonth,
    totalComplaints,
    resolvedComplaints,
    pendingComplaints,
    overdueComplaints,
  };
}

export async function getContentReportStatusByTicket(params: {
  prisma: PrismaClient;
  ticketId: string;
  reporterEmail: string;
}) {
  const { prisma, ticketId, reporterEmail } = params;
  const row = await prisma.contentReport.findUnique({ where: { ticketId } });
  if (!row || row.reporterEmail.toLowerCase() !== reporterEmail.toLowerCase()) {
    return null;
  }

  return {
    ticketId: row.ticketId,
    status: row.status,
    movieShowName: row.movieShowName,
    response: row.response,
    respondedAt: row.respondedAt,
    createdAt: row.createdAt,
  };
}

export async function listContentReportsForUser(params: {
  prisma: PrismaClient;
  userId: string;
  page: number;
  limit: number;
}) {
  const { prisma, userId, page, limit } = params;

  const [rows, total] = await Promise.all([
    prisma.contentReport.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.contentReport.count({ where: { userId } }),
  ]);

  const items = rows.map((row) => ({
    ticketId: row.ticketId,
    status: row.status,
    movieShowName: row.movieShowName,
    episodeName: row.episodeName,
    videoTimestamp: row.videoTimestamp,
    reason: row.reason,
    response: row.response,
    respondedAt: row.respondedAt,
    createdAt: row.createdAt,
  }));

  return {
    items,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };
}
