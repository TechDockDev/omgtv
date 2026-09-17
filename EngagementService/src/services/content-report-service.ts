import { Prisma, type PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { NotificationClient } from "../clients/notification-client";
import { escapeHtml } from "../utils/html";

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

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

  const dueAt = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000);

  // Insert directly instead of pre-checking uniqueness with a separate query —
  // with 33^8 (~2.8 trillion) possible ticket IDs a collision is astronomically
  // rare, so optimize for the common case (one write, no extra read) and only
  // fall back to retrying if the DB's own unique constraint actually rejects it.
  let ticketId = generateTicketId();
  let attempts = 0;
  const maxAttempts = 10;
  while (true) {
    try {
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
      break;
    } catch (error) {
      attempts++;
      if (isUniqueConstraintError(error) && attempts < maxAttempts) {
        ticketId = generateTicketId();
        continue;
      }
      throw error;
    }
  }

  // Fire-and-forget: the customer gets their ticket ID immediately, the
  // confirmation email (and its own DB update) happen in the background —
  // an email/SMTP round-trip must never be on the critical path of this response.
  const notificationClient = new NotificationClient();
  notificationClient
    .sendEmail(
      reporterEmail,
      `Your complaint ticket ${ticketId}`,
      buildConfirmationEmailHtml({ ticketId, reporterName, movieShowName, episodeName, videoTimestamp, reason })
    )
    .then((emailSent) => {
      if (emailSent) {
        return prisma.contentReport.update({ where: { ticketId }, data: { emailSent: true } });
      }
    })
    .catch((err) => {
      console.warn("[submitContentReport] Background email/update failed (non-fatal):", err);
    });

  return { ticketId };
}
