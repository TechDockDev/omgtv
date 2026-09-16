import type { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { NotificationClient } from "../clients/notification-client";
import { escapeHtml } from "../utils/html";

const TICKET_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I to avoid confusion when read aloud/typed

function generateTicketId(): string {
  const bytes = randomBytes(8);
  let suffix = "";
  for (let i = 0; i < 8; i++) {
    suffix += TICKET_ALPHABET[bytes[i] % TICKET_ALPHABET.length];
  }
  return `RPT-${suffix}`;
}

function buildConfirmationEmailHtml(params: {
  ticketId: string;
  reporterName: string;
  movieShowName: string;
  episodeName?: string;
  videoTimestamp: string;
  reason: string;
}): string {
  const { ticketId, reporterName, movieShowName, episodeName, videoTimestamp, reason } = params;
  return `
    <p>Hi ${escapeHtml(reporterName)},</p>
    <p>We've received your report and will look into it. Your complaint ticket ID is:</p>
    <p style="font-size:18px;font-weight:bold;">${escapeHtml(ticketId)}</p>
    <p><strong>Show:</strong> ${escapeHtml(movieShowName)}${episodeName ? `<br/><strong>Episode:</strong> ${escapeHtml(episodeName)}` : ""}<br/>
    <strong>Timestamp:</strong> ${escapeHtml(videoTimestamp)}<br/>
    <strong>Reason:</strong> ${escapeHtml(reason)}</p>
    <p>Please keep this ticket ID for reference if you need to follow up.</p>
  `;
}

export async function submitContentReport(params: {
  prisma: PrismaClient;
  userId?: string;
  reporterName: string;
  reporterEmail: string;
  movieShowName: string;
  episodeName?: string;
  videoTimestamp: string;
  reason: string;
}): Promise<{ ticketId: string }> {
  const { prisma, userId, reporterName, reporterEmail, movieShowName, episodeName, videoTimestamp, reason } = params;

  let ticketId = generateTicketId();
  let attempts = 0;
  const maxAttempts = 10;
  while (attempts < maxAttempts) {
    const existing = await prisma.contentReport.findUnique({ where: { ticketId } });
    if (!existing) break;
    ticketId = generateTicketId();
    attempts++;
  }
  if (attempts >= maxAttempts) {
    throw new Error("Could not generate a unique ticket ID after multiple attempts");
  }

  const dueAt = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000);

  await prisma.contentReport.create({
    data: {
      ticketId,
      userId,
      reporterName,
      reporterEmail,
      movieShowName,
      episodeName,
      videoTimestamp,
      reason,
      dueAt,
    },
  });

  const notificationClient = new NotificationClient();
  const emailSent = await notificationClient.sendEmail(
    reporterEmail,
    `Your complaint ticket ${ticketId}`,
    buildConfirmationEmailHtml({ ticketId, reporterName, movieShowName, episodeName, videoTimestamp, reason })
  );

  if (emailSent) {
    await prisma.contentReport.update({ where: { ticketId }, data: { emailSent: true } });
  }

  return { ticketId };
}
