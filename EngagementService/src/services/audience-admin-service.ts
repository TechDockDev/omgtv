import { Prisma, type AudienceConfig, type AudienceRegistrationStatus, type PrismaClient } from "@prisma/client";
import { csvRow } from "../utils/csv";
import { toIstIso } from "../utils/date-range";
import { AudienceError } from "./audience-errors";
import type { AudienceFileStorage } from "./audience-storage";
import { getRegistrationNotifier } from "./audience-notifier";
import { invalidateAudienceConfigCache } from "./audience-registration-service";

export type ConfigBody = {
  banner_enabled?: boolean;
  registration_open?: boolean;
  banner_image_url?: string | null;
  title?: string | null;
  subtitle?: string | null;
  cta_label?: string | null;
  starts_at?: string | null;
  ends_at?: string | null;
};

export function configToApi(row: AudienceConfig | null) {
  return {
    banner_enabled: row?.bannerEnabled ?? false,
    registration_open: row?.registrationOpen ?? false,
    banner_image_url: row?.bannerImageUrl ?? null,
    title: row?.title ?? null,
    subtitle: row?.subtitle ?? null,
    cta_label: row?.ctaLabel ?? null,
    starts_at: row?.startsAt ? toIstIso(row.startsAt) : null,
    ends_at: row?.endsAt ? toIstIso(row.endsAt) : null,
    updated_at: row ? toIstIso(row.updatedAt) : null,
  };
}

export async function getAdminConfig(prisma: PrismaClient) {
  return configToApi(await prisma.audienceConfig.findUnique({ where: { id: 1 } }));
}

export async function updateAdminConfig(
  prisma: PrismaClient,
  adminId: string | undefined,
  body: ConfigBody
) {
  const data: Prisma.AudienceConfigUncheckedUpdateInput = { updatedByAdminId: adminId ?? null };
  if (body.banner_enabled !== undefined) data.bannerEnabled = body.banner_enabled;
  if (body.registration_open !== undefined) data.registrationOpen = body.registration_open;
  if (body.banner_image_url !== undefined) data.bannerImageUrl = body.banner_image_url;
  if (body.title !== undefined) data.title = body.title;
  if (body.subtitle !== undefined) data.subtitle = body.subtitle;
  if (body.cta_label !== undefined) data.ctaLabel = body.cta_label;
  if (body.starts_at !== undefined) data.startsAt = body.starts_at ? new Date(body.starts_at) : null;
  if (body.ends_at !== undefined) data.endsAt = body.ends_at ? new Date(body.ends_at) : null;

  // The window can be changed one side at a time; validate the merged result.
  const current = await prisma.audienceConfig.findUnique({ where: { id: 1 } });
  const startsAt =
    body.starts_at !== undefined ? (body.starts_at ? new Date(body.starts_at) : null) : current?.startsAt ?? null;
  const endsAt =
    body.ends_at !== undefined ? (body.ends_at ? new Date(body.ends_at) : null) : current?.endsAt ?? null;
  if (startsAt && endsAt && startsAt >= endsAt) {
    throw new AudienceError("VALIDATION_FAILED", "Please fix the highlighted fields.", {
      ends_at: "ends_at must be after starts_at",
    });
  }

  const row = await prisma.audienceConfig.upsert({
    where: { id: 1 },
    update: data,
    // A brand-new row must never open registration by accident: it stays closed
    // until an admin explicitly sets registration_open: true.
    create: { id: 1, registrationOpen: false, ...(data as Prisma.AudienceConfigUncheckedCreateInput) },
  });
  invalidateAudienceConfigCache();
  return configToApi(row);
}

export interface RegistrationFilters {
  status?: AudienceRegistrationStatus;
  city?: string;
  from?: string; // YYYY-MM-DD, IST, inclusive
  to?: string; // YYYY-MM-DD, IST, inclusive
}

function buildWhere(filters: RegistrationFilters): Prisma.AudienceRegistrationWhereInput {
  const where: Prisma.AudienceRegistrationWhereInput = {};
  if (filters.status) where.status = filters.status;
  if (filters.city) where.city = { equals: filters.city, mode: "insensitive" };
  if (filters.from || filters.to) {
    const createdAt: Prisma.DateTimeFilter = {};
    if (filters.from) createdAt.gte = new Date(`${filters.from}T00:00:00.000+05:30`);
    if (filters.to) {
      createdAt.lt = new Date(
        new Date(`${filters.to}T00:00:00.000+05:30`).getTime() + 24 * 60 * 60 * 1000
      );
    }
    where.createdAt = createdAt;
  }
  return where;
}

export async function listRegistrations(
  prisma: PrismaClient,
  filters: RegistrationFilters & { page: number; limit: number }
) {
  const where = buildWhere(filters);
  const [rows, total] = await Promise.all([
    prisma.audienceRegistration.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (filters.page - 1) * filters.limit,
      take: filters.limit,
      include: { members: { where: { position: 1 } } },
    }),
    prisma.audienceRegistration.count({ where }),
  ]);
  return {
    items: rows.map((r) => ({
      registration_id: r.id,
      reference_id: r.referenceId,
      status: r.status,
      group_size: r.groupSize,
      city: r.city,
      lead_name: r.members[0]?.fullName ?? null,
      lead_mobile: r.leadMobile,
      lead_email: r.members[0]?.email ?? null,
      submitted_at: toIstIso(r.createdAt),
    })),
    pagination: {
      total,
      page: filters.page,
      limit: filters.limit,
      totalPages: Math.ceil(total / filters.limit),
    },
  };
}

export async function getRegistrationDetail(
  prisma: PrismaClient,
  id: string,
  storage: AudienceFileStorage | null
) {
  const reg = await prisma.audienceRegistration.findUnique({
    where: { id },
    include: {
      members: { orderBy: { position: "asc" } },
      files: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!reg) throw new AudienceError("NOT_FOUND", "Registration not found.");

  // Bucket is public-read (deliberately — permanent links for the admin
  // Sheet export), so this is a plain, non-expiring URL, not a signed one.
  const files = reg.files.map((f) => ({
    file_id: f.id,
    kind: f.kind,
    owner_position: f.ownerPosition,
    mime: f.mime,
    size: f.size,
    url: storage ? storage.publicUrl(f.storageKey) : null,
    url_expires_in: null,
  }));

  return {
    registration_id: reg.id,
    reference_id: reg.referenceId,
    status: reg.status,
    group_size: reg.groupSize,
    city: reg.city,
    user_id: reg.userId,
    consent: { text_version: reg.consentVersion, accepted_at: toIstIso(reg.consentAt) },
    device: reg.deviceInfo,
    submitted_at: toIstIso(reg.createdAt),
    members: reg.members.map((m) => ({
      position: m.position,
      full_name: m.fullName,
      age: m.age,
      mobile: m.mobile,
      email: m.email,
      photo_file_id: m.photoFileId,
    })),
    files,
  };
}

export async function updateRegistrationStatus(
  prisma: PrismaClient,
  id: string,
  status: AudienceRegistrationStatus
) {
  try {
    const reg = await prisma.audienceRegistration.update({ where: { id }, data: { status } });

    // Fire-and-forget: email every group member about the status change.
    // Must never block the admin response on SMTP/provider latency.
    void getRegistrationNotifier()
      .enqueueStatusChange({ registrationId: reg.id, newStatus: status })
      .catch(() => console.warn("[audience] status-change notification could not be queued"));

    return { registration_id: reg.id, reference_id: reg.referenceId, status: reg.status };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      throw new AudienceError("NOT_FOUND", "Registration not found.");
    }
    throw err;
  }
}

const CSV_HEADER = [
  "reference_id",
  "status",
  "submitted_at",
  "city",
  "group_size",
  "position",
  "role",
  "full_name",
  "age",
  "mobile",
  "email",
  "has_photo",
  "group_pdf",
];

// One row per person, so the casting team can filter and sort individuals.
export async function exportRegistrationsCsv(
  prisma: PrismaClient,
  filters: RegistrationFilters
): Promise<string> {
  const where = buildWhere(filters);
  const lines: string[] = [csvRow(CSV_HEADER)];
  let cursor: string | undefined;
  for (;;) {
    const batch = await prisma.audienceRegistration.findMany({
      where,
      orderBy: { id: "asc" },
      take: 500,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { members: { orderBy: { position: "asc" } }, files: { select: { kind: true } } },
    });
    if (batch.length === 0) break;
    for (const reg of batch) {
      const hasPdf = reg.files.some((f) => f.kind === "GROUP_PDF");
      for (const m of reg.members) {
        lines.push(
          csvRow([
            reg.referenceId,
            reg.status,
            toIstIso(reg.createdAt),
            reg.city,
            reg.groupSize,
            m.position,
            m.position === 1 ? "LEAD" : "MEMBER",
            m.fullName,
            m.age,
            m.mobile,
            m.email,
            m.photoFileId ? "yes" : "no",
            hasPdf ? "yes" : "no",
          ])
        );
      }
    }
    cursor = batch[batch.length - 1].id;
  }
  return lines.join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------- email template image

export async function getEmailTemplateImage(prisma: PrismaClient) {
  const row = await prisma.audienceConfig.findUnique({ where: { id: 1 } });
  return { email_banner_image_url: row?.emailBannerImageUrl ?? null };
}

// The admin pastes a link from the existing media library — same pattern as
// banner_image_url. No upload/storage path here.
export async function updateEmailTemplateImage(
  prisma: PrismaClient,
  adminId: string | undefined,
  emailBannerImageUrl: string | null
) {
  const row = await prisma.audienceConfig.upsert({
    where: { id: 1 },
    update: { emailBannerImageUrl, updatedByAdminId: adminId ?? null },
    create: { id: 1, registrationOpen: false, emailBannerImageUrl, updatedByAdminId: adminId ?? null },
  });
  invalidateAudienceConfigCache();
  return { email_banner_image_url: row.emailBannerImageUrl };
}
