import type { AudienceRegistrationStatus, PrismaClient } from "@prisma/client";
import { NotificationClient } from "../clients/notification-client";
import { toIstIso } from "../utils/date-range";
import {
  buildRegistrationConfirmationHtml,
  buildStatusChangeHtml,
  registrationSubject,
  statusChangeSubject,
  type RegistrationEmailData,
  type StatusChangeEmailData,
} from "./audience-email-templates";

// ── Job shapes ─────────────────────────────────────────────────────────────

export interface RegistrationReceivedJob {
  registrationId: string;
  referenceId: string;
  groupSize: number;
}

export interface StatusChangeJob {
  registrationId: string;
  newStatus: AudienceRegistrationStatus;
}

// ── Interface ──────────────────────────────────────────────────────────────

// Deliberately carries no PII: the implementation loads contact details from
// the DB by registrationId when it actually sends, so the caller never
// passes personal data through the queue boundary.
export interface RegistrationNotifier {
  enqueueConfirmation(job: RegistrationReceivedJob): Promise<void>;
  enqueueStatusChange(job: StatusChangeJob): Promise<void>;
}

// ── Shared member loader ───────────────────────────────────────────────────

interface MemberInfo {
  position: number;
  fullName: string;
  email: string;
  role: "LEAD" | "MEMBER";
}

interface RegistrationInfo {
  referenceId: string;
  groupSize: number;
  city: string;
  status: string;
  createdAt: Date;
  members: MemberInfo[];
  leadName: string;
}

async function loadRegistration(
  prisma: PrismaClient,
  registrationId: string
): Promise<RegistrationInfo | null> {
  const reg = await prisma.audienceRegistration.findUnique({
    where: { id: registrationId },
    include: { members: { orderBy: { position: "asc" } } },
  });
  if (!reg) return null;
  return {
    referenceId: reg.referenceId,
    groupSize: reg.groupSize,
    city: reg.city,
    status: reg.status,
    createdAt: reg.createdAt,
    members: reg.members.map((m) => ({
      position: m.position,
      fullName: m.fullName,
      email: m.email,
      role: m.position === 1 ? "LEAD" as const : "MEMBER" as const,
    })),
    leadName: reg.members.find((m) => m.position === 1)?.fullName ?? "Group Lead",
  };
}

// ── Real implementation ────────────────────────────────────────────────────

// Uses the existing NotificationClient (HTTP → NotificationService SMTP) to
// send emails to ALL members of the group. Every send is fire-and-forget and
// non-fatal — an SMTP outage must never break the registration or admin flow.

class EmailRegistrationNotifier implements RegistrationNotifier {
  private readonly client = new NotificationClient();
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async enqueueConfirmation(job: RegistrationReceivedJob): Promise<void> {
    const reg = await loadRegistration(this.prisma, job.registrationId);
    if (!reg) {
      console.warn(`[audience-notifier] registration ${job.registrationId} not found — skipping`);
      return;
    }

    const config = await this.prisma.audienceConfig.findUnique({ where: { id: 1 } });
    const bannerImageUrl = config?.bannerImageUrl;

    const subject = registrationSubject(reg.referenceId);
    const submittedAt = toIstIso(reg.createdAt);

    // Send to every member (lead + all members) in parallel, non-fatal.
    const sends = reg.members.map(async (member) => {
      const data: RegistrationEmailData = {
        referenceId: reg.referenceId,
        groupSize: reg.groupSize,
        leadName: reg.leadName,
        city: reg.city,
        status: reg.status,
        submittedAt,
        recipientName: member.fullName,
        recipientRole: member.role,
        bannerImageUrl,
      };
      const html = buildRegistrationConfirmationHtml(data);
      const sent = await this.client.sendEmail(member.email, subject, html);
      if (sent) {
        console.info(
          `[audience-notifier] confirmation sent to ${member.role} position=${member.position} ref=${reg.referenceId}`
        );
      }
    });

    await Promise.allSettled(sends);
  }

  async enqueueStatusChange(job: StatusChangeJob): Promise<void> {
    const reg = await loadRegistration(this.prisma, job.registrationId);
    if (!reg) {
      console.warn(`[audience-notifier] registration ${job.registrationId} not found — skipping`);
      return;
    }

    const config = await this.prisma.audienceConfig.findUnique({ where: { id: 1 } });
    const bannerImageUrl = config?.bannerImageUrl;

    const subject = statusChangeSubject(reg.referenceId, job.newStatus);

    // Send to every member (lead + all members) in parallel, non-fatal.
    const sends = reg.members.map(async (member) => {
      const data: StatusChangeEmailData = {
        referenceId: reg.referenceId,
        groupSize: reg.groupSize,
        leadName: reg.leadName,
        city: reg.city,
        newStatus: job.newStatus,
        recipientName: member.fullName,
        recipientRole: member.role,
        bannerImageUrl,
      };
      const html = buildStatusChangeHtml(data);
      const sent = await this.client.sendEmail(member.email, subject, html);
      if (sent) {
        console.info(
          `[audience-notifier] status=${job.newStatus} sent to ${member.role} position=${member.position} ref=${reg.referenceId}`
        );
      }
    });

    await Promise.allSettled(sends);
  }
}

// ── Fallback for when Prisma / SMTP isn't available (tests, CLI scripts) ──

class LoggingRegistrationNotifier implements RegistrationNotifier {
  async enqueueConfirmation(job: RegistrationReceivedJob): Promise<void> {
    console.info(
      `[audience-notifier] confirmation job queued (stub) reference=${job.referenceId} group_size=${job.groupSize}`
    );
  }
  async enqueueStatusChange(job: StatusChangeJob): Promise<void> {
    console.info(
      `[audience-notifier] status-change job queued (stub) registration=${job.registrationId} status=${job.newStatus}`
    );
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────

let notifier: RegistrationNotifier = new LoggingRegistrationNotifier();

export function getRegistrationNotifier(): RegistrationNotifier {
  return notifier;
}

export function setRegistrationNotifier(next: RegistrationNotifier) {
  notifier = next;
}

/**
 * Call once at startup (after Prisma is ready) to wire up the real email
 * notifier. Until this is called the logging stub is active.
 */
export function initRealNotifier(prisma: PrismaClient) {
  notifier = new EmailRegistrationNotifier(prisma);
}
