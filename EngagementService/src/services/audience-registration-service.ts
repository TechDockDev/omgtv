import { randomBytes, randomUUID } from "node:crypto";
import type Redis from "ioredis";
import { Prisma, type AudienceConfig, type PrismaClient } from "@prisma/client";
import { loadConfig } from "../config";
import { fetchCustomerPhone, normalizeIndianMobile } from "../clients/user-client";
import {
  parseRegistrationPayload,
  type NormalizedPerson,
  type NormalizedRegistration,
} from "../schemas/audience";
import { sniffFile, type SniffedFile } from "../utils/file-sniff";
import { sanitizeImage } from "../utils/image-sanitize";
import { toIstIso } from "../utils/date-range";
import { AudienceError } from "./audience-errors";
import {
  newStorageKey,
  requireAudienceStorage,
  type AudienceFileStorage,
} from "./audience-storage";
import { getRegistrationNotifier } from "./audience-notifier";
import { getSheetsExporter } from "./audience-sheets";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PDF_BYTES = 10 * 1024 * 1024;

// Each in-flight submission can hold ~60 MB of buffers (10 photos + PDF) plus
// sharp working memory, so cap concurrency per pod instead of risking an OOM.
const MAX_CONCURRENT_SUBMISSIONS = 6;
let inflightSubmissions = 0;

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;

const REFERENCE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 chars -> byte % 32 is unbiased

export function generateReferenceId(): string {
  const bytes = randomBytes(6);
  let suffix = "";
  for (let i = 0; i < 6; i++) suffix += REFERENCE_ALPHABET[bytes[i] % REFERENCE_ALPHABET.length];
  return `IFF-${suffix}`;
}

export function maskMobile(mobile: string): string {
  return `+91 ${mobile.slice(0, 5)} XXXXX`;
}

// ---------------------------------------------------------------- config/banner

const CONFIG_CACHE_TTL_MS = 60_000;
let configCache: { value: AudienceConfig | null; expiresAt: number } | null = null;

export function invalidateAudienceConfigCache() {
  configCache = null;
}

async function loadConfigSnapshot(prisma: PrismaClient): Promise<AudienceConfig | null> {
  const now = Date.now();
  if (configCache && configCache.expiresAt > now) return configCache.value;
  const value = await prisma.audienceConfig.findUnique({ where: { id: 1 } });
  configCache = { value, expiresAt: now + CONFIG_CACHE_TTL_MS };
  return value;
}

export function isWithinWindow(cfg: AudienceConfig, now: Date): boolean {
  if (cfg.startsAt && now < cfg.startsAt) return false;
  if (cfg.endsAt && now > cfg.endsAt) return false;
  return true;
}

export function isRegistrationOpen(cfg: AudienceConfig, now: Date): boolean {
  return cfg.registrationOpen && isWithinWindow(cfg, now);
}

export async function getBanner(prisma: PrismaClient, now = new Date()) {
  const cfg = await loadConfigSnapshot(prisma);
  if (!cfg || !cfg.bannerEnabled || !isWithinWindow(cfg, now)) {
    return { enabled: false, banner: null };
  }
  return {
    enabled: true,
    banner: {
      id: `bnr_${cfg.updatedAt.getTime().toString(36)}`,
      image_url: cfg.bannerImageUrl,
      title: cfg.title,
      subtitle: cfg.subtitle,
      cta_label: cfg.ctaLabel,
      registration_open: isRegistrationOpen(cfg, now),
      starts_at: cfg.startsAt ? toIstIso(cfg.startsAt) : null,
      ends_at: cfg.endsAt ? toIstIso(cfg.endsAt) : null,
    },
  };
}

// ---------------------------------------------------------------- submit

export interface SubmitInput {
  prisma: PrismaClient;
  redis: Redis | null;
  userId?: string;
  idempotencyKey?: string; // Idempotency-Key header; falls back to payload.client_request_id
  payloadRaw: string;
  photos: Map<number, Buffer>; // position -> raw bytes
  groupPdf?: Buffer;
  storage?: AudienceFileStorage; // injectable for tests
}

export interface SubmitResult {
  registration_id: string;
  reference_id: string;
  status: "RECEIVED";
  group_size: number;
  submitted_at: string;
}

interface ValidatedFile {
  kind: "PHOTO" | "GROUP_PDF";
  position: number | null;
  raw: Buffer;
  sniffed: SniffedFile;
}

function toResult(reg: { id: string; referenceId: string; groupSize: number; createdAt: Date }): SubmitResult {
  return {
    registration_id: reg.id,
    reference_id: reg.referenceId,
    status: "RECEIVED",
    group_size: reg.groupSize,
    submitted_at: toIstIso(reg.createdAt),
  };
}

const personField = (person: NormalizedPerson, leaf: string) =>
  person.memberIndex === null ? `lead.${leaf}` : `members[${person.memberIndex}].${leaf}`;

/** Cheap structural file checks. No image decoding happens here. */
function validateFiles(norm: NormalizedRegistration, input: SubmitInput): ValidatedFile[] {
  const files: ValidatedFile[] = [];
  const mismatch: Record<string, string> = {};

  for (const position of input.photos.keys()) {
    if (!norm.photoPositions.has(position)) {
      mismatch.photos_provided = "A photo was attached that is not listed in photos_provided";
    }
  }
  for (const position of norm.photoPositions) {
    if (!input.photos.has(position)) {
      mismatch.photos_provided = "A photo listed in photos_provided was not attached";
    }
  }
  if (norm.groupPdfProvided !== Boolean(input.groupPdf)) {
    mismatch.group_pdf_provided = norm.groupPdfProvided
      ? "group_pdf_provided is true but no PDF was attached"
      : "A PDF was attached but group_pdf_provided is false";
  }
  if (Object.keys(mismatch).length > 0) {
    throw new AudienceError("VALIDATION_FAILED", "Please fix the highlighted fields.", mismatch);
  }

  if (!input.groupPdf) {
    const missing: Record<string, string> = {};
    for (const person of norm.people) {
      if (!norm.photoPositions.has(person.position)) {
        missing[personField(person, "photo")] = "Add a photo, or attach the group PDF";
      }
    }
    if (Object.keys(missing).length > 0) {
      throw new AudienceError(
        "PHOTO_OR_PDF_REQUIRED",
        "Every person needs a photo, or attach one group PDF.",
        missing
      );
    }
  }

  for (const [position, raw] of input.photos) {
    const sniffed = sniffFile(raw);
    if (!sniffed || sniffed.kind !== "image") {
      throw new AudienceError("UNSUPPORTED_FILE", "Photos must be JPEG, PNG or WebP images.");
    }
    if (raw.length > MAX_IMAGE_BYTES) {
      throw new AudienceError("FILE_TOO_LARGE", "Each photo must be 5 MB or smaller.");
    }
    files.push({ kind: "PHOTO", position, raw, sniffed });
  }
  if (input.groupPdf) {
    const sniffed = sniffFile(input.groupPdf);
    if (!sniffed || sniffed.kind !== "pdf") {
      throw new AudienceError("UNSUPPORTED_FILE", "The group file must be a PDF.");
    }
    if (input.groupPdf.length > MAX_PDF_BYTES) {
      throw new AudienceError("FILE_TOO_LARGE", "The group PDF must be 10 MB or smaller.");
    }
    files.push({ kind: "GROUP_PDF", position: null, raw: input.groupPdf, sniffed });
  }
  return files;
}

/**
 * Finds why this submission collides with existing data. For a mobile that
 * belongs to ANOTHER registration only the field position is reported, never
 * who owns it. The existing reference_id is only returned to the account that
 * owns that registration.
 */
async function findConflict(
  prisma: PrismaClient,
  norm: NormalizedRegistration,
  userId: string | undefined
): Promise<AudienceError | null> {
  if (userId) {
    const own = await prisma.audienceRegistration.findUnique({
      where: { userId },
      select: { referenceId: true },
    });
    if (own) {
      return new AudienceError(
        "ALREADY_REGISTERED",
        "You have already registered.",
        undefined,
        own.referenceId
      );
    }
  }

  const existing = await prisma.audienceRegistrationMember.findMany({
    where: { mobile: { in: norm.people.map((p) => p.mobile) } },
    select: { mobile: true, position: true, registration: { select: { userId: true, referenceId: true } } },
  });
  if (existing.length === 0) return null;

  const fields: Record<string, string> = {};
  for (const row of existing) {
    const person = norm.people.find((p) => p.mobile === row.mobile);
    if (!person) continue;
    if (
      person.position === 1 &&
      row.position === 1 &&
      userId &&
      row.registration.userId === userId
    ) {
      return new AudienceError(
        "ALREADY_REGISTERED",
        "You have already registered.",
        undefined,
        row.registration.referenceId
      );
    }
    fields[personField(person, "mobile")] = "This mobile number is already registered";
  }
  return new AudienceError(
    "DUPLICATE_MOBILE",
    "A mobile number in this group is already registered.",
    fields
  );
}

async function enforceMobileRateLimit(redis: Redis | null, leadMobile: string) {
  if (!redis) return; // no Redis -> gateway IP limiting only
  const config = loadConfig();
  try {
    const key = `audience:submit:${leadMobile}`;
    const attempts = await redis.incr(key);
    if (attempts === 1) await redis.expire(key, config.AUDIENCE_SUBMIT_WINDOW_SECONDS);
    if (attempts > config.AUDIENCE_SUBMIT_MAX_PER_MOBILE) {
      throw new AudienceError("RATE_LIMITED", "Too many attempts. Please try again later.");
    }
  } catch (err) {
    if (err instanceof AudienceError) throw err;
    // Redis outage must not block registrations.
    console.warn("[audience] mobile rate limit skipped: redis unavailable");
  }
}

export async function submitRegistration(input: SubmitInput): Promise<SubmitResult> {
  if (inflightSubmissions >= MAX_CONCURRENT_SUBMISSIONS) {
    throw new AudienceError("RATE_LIMITED", "We are receiving many registrations. Please retry in a moment.");
  }
  inflightSubmissions++;
  try {
    return await runSubmission(input);
  } finally {
    inflightSubmissions--;
  }
}

async function runSubmission(input: SubmitInput): Promise<SubmitResult> {
  const { prisma, redis, userId } = input;

  const norm = parseRegistrationPayload(input.payloadRaw);
  const lead = norm.people[0];

  const idempotencyKey = input.idempotencyKey ?? norm.clientRequestId;
  if (!idempotencyKey || !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    throw new AudienceError("VALIDATION_FAILED", "Please fix the highlighted fields.", {
      "Idempotency-Key": "A valid Idempotency-Key header (8-128 letters, digits, - or _) is required",
    });
  }

  // 1. Idempotent replay: same key -> original response, nothing new created.
  const replayed = await prisma.audienceRegistration.findUnique({ where: { idempotencyKey } });
  if (replayed) {
    if (replayed.leadMobile !== lead.mobile) {
      throw new AudienceError("VALIDATION_FAILED", "Please fix the highlighted fields.", {
        "Idempotency-Key": "This key was already used for a different request",
      });
    }
    return toResult(replayed);
  }

  // 2. Cheap validation + business pre-checks before any expensive work.
  const files = validateFiles(norm, input);

  const cfg = await loadConfigSnapshot(prisma);
  const now = new Date();
  if (!cfg || !isRegistrationOpen(cfg, now)) {
    throw new AudienceError("REGISTRATION_CLOSED", "Registrations are closed.");
  }

  // Counted only once the form is valid, so fixing typos never burns attempts;
  // it guards the duplicate lookups and the upload/sharp path below.
  await enforceMobileRateLimit(redis, lead.mobile);

  const conflict = await findConflict(prisma, norm, userId);
  if (conflict) throw conflict;

  // 3. Sanitize + upload. Anything uploaded is deleted again if we fail later.
  const storage = input.storage ?? requireAudienceStorage();
  const uploadedKeys: string[] = [];
  try {
    const stored = await Promise.all(
      files.map(async (file) => {
        const body =
          file.sniffed.kind === "image" ? await sanitizeImage(file.raw, file.sniffed) : file.raw;
        const key = newStorageKey(file.sniffed.ext);
        await storage.put(key, body, file.sniffed.mime);
        uploadedKeys.push(key);
        return {
          id: randomUUID(),
          kind: file.kind,
          ownerPosition: file.position,
          storageKey: key,
          mime: file.sniffed.mime,
          size: body.length,
        };
      })
    );

    const photoFileId = new Map<number, string>();
    for (const file of stored) {
      if (file.kind === "PHOTO" && file.ownerPosition != null) photoFileId.set(file.ownerPosition, file.id);
    }

    // 4. Commit. Re-check open/closed inside the transaction (an admin may have
    //    closed registrations between step 2 and here) before creating the row.
    for (let attempt = 0; attempt < 5; attempt++) {
      const referenceId = generateReferenceId();
      try {
        const created = await prisma.$transaction(
          async (tx) => {
            const cfg = await tx.audienceConfig.findUnique({ where: { id: 1 } });
            if (!cfg || !isRegistrationOpen(cfg, new Date())) {
              throw new AudienceError("REGISTRATION_CLOSED", "Registrations are closed.");
            }
            return tx.audienceRegistration.create({
              data: {
                referenceId,
                userId: userId ?? null,
                leadMobile: lead.mobile,
                groupSize: norm.people.length,
                city: norm.city,
                consentVersion: norm.consent.version,
                consentAt: norm.consent.acceptedAt,
                deviceInfo: norm.device ?? undefined,
                idempotencyKey,
                members: {
                  create: norm.people.map((p) => ({
                    position: p.position,
                    fullName: p.fullName,
                    age: p.age,
                    mobile: p.mobile,
                    email: p.email,
                    photoFileId: photoFileId.get(p.position) ?? null,
                  })),
                },
                files: { create: stored },
              },
            });
          },
          { maxWait: 10_000, timeout: 20_000 }
        );

        invalidateAudienceConfigCache();
        const result = toResult(created);
        void getRegistrationNotifier()
          .enqueueConfirmation({
            registrationId: created.id,
            referenceId: created.referenceId,
            groupSize: created.groupSize,
          })
          .catch(() => console.warn("[audience] confirmation job could not be queued"));

        // Best-effort admin convenience copy. Never blocks or fails the
        // registration — the DB row above is already committed either way.
        // Links are permanent public URLs — see audience-storage.ts for why
        // the bucket is public-read rather than signed-URL-only.
        const photoLinkByPosition = new Map<number, string>();
        let groupPdfLink: string | null = null;
        for (const f of stored) {
          if (f.kind === "PHOTO" && f.ownerPosition != null) {
            photoLinkByPosition.set(f.ownerPosition, storage.publicUrl(f.storageKey));
          } else if (f.kind === "GROUP_PDF") {
            groupPdfLink = storage.publicUrl(f.storageKey);
          }
        }
        void getSheetsExporter()
          .appendRow({
            referenceId: created.referenceId,
            registrationId: created.id,
            userId: created.userId,
            status: created.status,
            createdAt: created.createdAt,
            groupSize: created.groupSize,
            city: created.city,
            people: norm.people,
            consent: norm.consent,
            photoLinkByPosition,
            groupPdfLink,
          })
          .catch(() => console.warn("[audience] sheet row append failed"));

        return result;
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") throw err;
        const target = String(err.meta?.target ?? "");
        if (target.includes("referenceId")) continue; // regenerate and retry

        // A concurrent request with the SAME idempotency key won the race. Which
        // unique index Postgres reports first is arbitrary (leadMobile, mobile
        // and idempotencyKey all collide), so look the key up directly: this is a
        // replay, not a conflict. Our own uploads are surplus and get removed.
        const original = await prisma.audienceRegistration.findUnique({ where: { idempotencyKey } });
        if (original && original.leadMobile === lead.mobile) {
          await Promise.allSettled(uploadedKeys.map((key) => storage.remove(key)));
          return toResult(original);
        }

        const raced = await findConflict(prisma, norm, userId);
        if (raced) throw raced;
        throw err;
      }
    }
    throw new AudienceError("INTERNAL_ERROR", "Could not allocate a reference ID. Please retry.");
  } catch (err) {
    await Promise.allSettled(uploadedKeys.map((key) => storage.remove(key)));
    throw err;
  }
}

// ---------------------------------------------------------------- status

const STATUS_MESSAGES: Record<string, string> = {
  RECEIVED:
    "You are registered. Your status is pending. Once our team approves your details, you will receive an update in your email.",
  WAITLISTED:
    "You are on the waitlist. We will email you if a seat becomes available.",
  SHORTLISTED:
    "Congratulations! You have been shortlisted. Our team will email you the next steps.",
  NOT_SELECTED:
    "Thank you for registering. Unfortunately your group was not selected this time.",
};

export interface StatusInput {
  prisma: PrismaClient;
  userId?: string; // authenticated customer
  mobileQuery?: string; // only honoured when AUDIENCE_ALLOW_MOBILE_LOOKUP=true and no user
}

export async function getRegistrationStatus(input: StatusInput) {
  const { prisma, userId, mobileQuery } = input;

  let mobile: string | null = null;
  if (userId) {
    mobile = normalizeIndianMobile(await fetchCustomerPhone(userId));
  } else if (mobileQuery) {
    if (!loadConfig().AUDIENCE_ALLOW_MOBILE_LOOKUP) {
      throw new AudienceError("UNAUTHORIZED", "Please log in to check your registration.");
    }
    mobile = mobileQuery;
  } else {
    throw new AudienceError("UNAUTHORIZED", "Please log in to check your registration.");
  }

  // Anyone listed in a group (lead or member) counts as registered.
  const member = mobile
    ? await prisma.audienceRegistrationMember.findUnique({
      where: { mobile },
      select: { position: true, registrationId: true },
    })
    : null;
  let registrationId = member?.registrationId ?? null;
  let role: "LEAD" | "MEMBER" = member?.position === 1 ? "LEAD" : "MEMBER";

  if (!registrationId && userId) {
    const own = await prisma.audienceRegistration.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (own) {
      registrationId = own.id;
      role = "LEAD";
    }
  }
  if (!registrationId) return { has_filled: false, registration: null };

  const reg = await prisma.audienceRegistration.findUnique({
    where: { id: registrationId },
    include: { members: { where: { position: 1 }, select: { fullName: true } } },
  });
  if (!reg) return { has_filled: false, registration: null };

  return {
    has_filled: true,
    registration: {
      registration_id: reg.id,
      reference_id: reg.referenceId,
      status: reg.status,
      group_size: reg.groupSize,
      lead_name: reg.members[0]?.fullName ?? null,
      lead_mobile_masked: maskMobile(reg.leadMobile),
      city: reg.city,
      submitted_at: toIstIso(reg.createdAt),
      your_role: role,
      message: STATUS_MESSAGES[reg.status],
    },
  };
}
