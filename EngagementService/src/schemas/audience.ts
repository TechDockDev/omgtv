import { z } from "zod";
import { AudienceError } from "../services/audience-errors";

export const MIN_GROUP_SIZE = 5;
export const MAX_GROUP_SIZE = 10;
export const MAX_PAYLOAD_CHARS = 256 * 1024;

const MOBILE_RE = /^[6-9]\d{9}$/;
// No HTML-ish or control characters in free-text fields. (Output encoding in
// emails/CSV is handled separately; this just keeps junk out of the DB.)
const SAFE_TEXT_RE = /^[^<>\u0000-\u001F\u007F]*$/;

const collapse = (value: string) => value.replace(/\s+/g, " ").trim();

const text = (label: string, min: number, max: number) =>
  z
    .string({ required_error: `${label} is required`, invalid_type_error: `${label} must be text` })
    .transform(collapse)
    .pipe(
      z
        .string()
        .min(min, `${label} must be at least ${min} characters`)
        .max(max, `${label} must be at most ${max} characters`)
        .regex(SAFE_TEXT_RE, `${label} contains invalid characters`)
    );

const mobile = z
  .string({ required_error: "Mobile number is required", invalid_type_error: "Mobile number must be text" })
  .regex(MOBILE_RE, "Enter a 10-digit mobile number starting with 6, 7, 8 or 9");

const email = z
  .string({ required_error: "Email is required", invalid_type_error: "Email must be text" })
  .trim()
  .toLowerCase()
  .max(254, "Email is too long")
  .email("Enter a valid email, like name@example.com");

const age = z
  .number({ required_error: "Age is required", invalid_type_error: "Age must be a number" })
  .int("Age must be a whole number")
  .min(1, "Age must be between 1 and 99")
  .max(99, "Age must be between 1 and 99");

const PHOTO_KEYS = [
  "lead",
  ...Array.from({ length: MAX_GROUP_SIZE - 1 }, (_, i) => `member_${i + 2}`),
] as [string, ...string[]];

const personFields = {
  full_name: text("Full name", 2, 80),
  age,
  mobile,
  email,
};

export const registrationPayloadSchema = z.object({
  client_request_id: z.string().uuid("client_request_id must be a UUID").optional(),
  lead: z.object({ ...personFields, city: text("City", 2, 60) }),
  members: z.array(
    z.object({
      position: z
        .number({ required_error: "Position is required", invalid_type_error: "Position must be a number" })
        .int()
        .min(2)
        .max(MAX_GROUP_SIZE),
      ...personFields,
    })
  ),
  photos_provided: z.array(z.enum(PHOTO_KEYS)).default([]),
  group_pdf_provided: z.boolean().default(false),
  consent: z.object({
    accepted: z.literal(true, {
      errorMap: () => ({ message: "You must accept the consent to register" }),
    }),
    text_version: z.string().trim().min(1, "Consent version is required").max(20),
    accepted_at: z.string().datetime({ offset: true, message: "accepted_at must be an ISO-8601 timestamp" }),
  }),
  device: z
    .object({
      platform: z.string().trim().max(20).optional(),
      app_version: z.string().trim().max(20).optional(),
    })
    .optional(),
});

export type RegistrationPayload = z.infer<typeof registrationPayloadSchema>;

export interface NormalizedPerson {
  position: number;
  /** Index in the submitted members[] array (null for the lead). */
  memberIndex: number | null;
  fullName: string;
  age: number;
  mobile: string;
  email: string;
}

export interface NormalizedRegistration {
  clientRequestId?: string;
  city: string;
  people: NormalizedPerson[]; // position 1 (lead) first, then members by position
  photoPositions: Set<number>;
  groupPdfProvided: boolean;
  consent: { version: string; acceptedAt: Date };
  device: { platform?: string; app_version?: string } | undefined;
}

/** ["members", 1, "mobile"] -> "members[1].mobile" */
export function formatIssuePath(path: (string | number)[]): string {
  return path.reduce<string>((acc, part) => {
    if (typeof part === "number") return `${acc}[${part}]`;
    return acc ? `${acc}.${part}` : part;
  }, "");
}

export function zodIssuesToFields(issues: z.ZodIssue[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of issues) {
    const key = formatIssuePath(issue.path) || "payload";
    if (!(key in fields)) fields[key] = issue.message;
  }
  return fields;
}

export function photoKeyToPosition(key: string): number {
  return key === "lead" ? 1 : Number(key.slice("member_".length));
}

export function parseRegistrationPayload(raw: string): NormalizedRegistration {
  if (raw.length > MAX_PAYLOAD_CHARS) {
    throw new AudienceError("VALIDATION_FAILED", "Please fix the highlighted fields.", {
      payload: "Payload is too large",
    });
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new AudienceError("VALIDATION_FAILED", "Please fix the highlighted fields.", {
      payload: "Payload must be valid JSON",
    });
  }

  // Group size is reported with its own error codes, ahead of per-field issues.
  const rawMembers = (json as { members?: unknown } | null)?.members;
  if (Array.isArray(rawMembers)) {
    const size = 1 + rawMembers.length;
    if (size < MIN_GROUP_SIZE) {
      throw new AudienceError(
        "GROUP_TOO_SMALL",
        `A group needs at least ${MIN_GROUP_SIZE} people including you.`
      );
    }
    if (size > MAX_GROUP_SIZE) {
      throw new AudienceError(
        "GROUP_TOO_LARGE",
        `A group can have at most ${MAX_GROUP_SIZE} people including you.`
      );
    }
  }

  const parsed = registrationPayloadSchema.safeParse(json);
  if (!parsed.success) {
    throw new AudienceError(
      "VALIDATION_FAILED",
      "Please fix the highlighted fields.",
      zodIssuesToFields(parsed.error.issues)
    );
  }
  const data = parsed.data;
  const size = 1 + data.members.length;

  // Members must occupy exactly positions 2..size, once each.
  const positionErrors: Record<string, string> = {};
  const seenPositions = new Set<number>();
  data.members.forEach((member, index) => {
    if (member.position > size || seenPositions.has(member.position)) {
      positionErrors[`members[${index}].position`] = `Positions must be unique and between 2 and ${size}`;
    }
    seenPositions.add(member.position);
  });
  if (Object.keys(positionErrors).length > 0) {
    throw new AudienceError("VALIDATION_FAILED", "Please fix the highlighted fields.", positionErrors);
  }

  // Each declared photo must belong to someone in this group.
  const photoPositions = new Set<number>();
  for (const key of data.photos_provided) {
    const position = photoKeyToPosition(key);
    if (position > size) {
      throw new AudienceError("VALIDATION_FAILED", "Please fix the highlighted fields.", {
        photos_provided: `${key} is not part of a group of ${size}`,
      });
    }
    photoPositions.add(position);
  }

  const sortedMembers = data.members
    .map((m, memberIndex) => ({ m, memberIndex }))
    .sort((a, b) => a.m.position - b.m.position);
  const people: NormalizedPerson[] = [
    {
      position: 1,
      memberIndex: null,
      fullName: data.lead.full_name,
      age: data.lead.age,
      mobile: data.lead.mobile,
      email: data.lead.email,
    },
    ...sortedMembers.map(({ m, memberIndex }) => ({
      position: m.position,
      memberIndex,
      fullName: m.full_name,
      age: m.age,
      mobile: m.mobile,
      email: m.email,
    })),
  ];

  // Mobiles must be unique inside the group. Field keys use the original array
  // index so the app can highlight the right row.
  const firstSeen = new Map<string, number>();
  const duplicateFields: Record<string, string> = {};
  for (const person of people) {
    if (firstSeen.has(person.mobile)) {
      duplicateFields[
        person.memberIndex === null ? "lead.mobile" : `members[${person.memberIndex}].mobile`
      ] =
        "This mobile number is used more than once in your group";
    } else {
      firstSeen.set(person.mobile, person.position);
    }
  }
  if (Object.keys(duplicateFields).length > 0) {
    throw new AudienceError(
      "DUPLICATE_MOBILE",
      "Each person in the group needs a different mobile number.",
      duplicateFields
    );
  }

  return {
    clientRequestId: data.client_request_id,
    city: data.lead.city,
    people,
    photoPositions,
    groupPdfProvided: data.group_pdf_provided,
    consent: { version: data.consent.text_version, acceptedAt: new Date(data.consent.accepted_at) },
    device: data.device,
  };
}

// --- Admin schemas ---

const istDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const adminListQuerySchema = z.object({
  status: z.enum(["RECEIVED", "WAITLISTED", "SHORTLISTED", "NOT_SELECTED"]).optional(),
  city: z.string().trim().min(1).max(60).optional(),
  from: istDate.optional(),
  to: istDate.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const adminStatusBodySchema = z.object({
  status: z.enum(["RECEIVED", "WAITLISTED", "SHORTLISTED", "NOT_SELECTED"]),
});

// Any image format works (JPG/PNG/WebP/animated GIF) since this is only a URL
// the app/email client loads. Restricted to http(s) so javascript:/data: URLs
// can't be stored and later rendered by an admin or client.
const imageUrlSchema = z
  .string()
  .url()
  .max(2000)
  .refine((value) => /^https?:\/\//i.test(value), { message: "Image URL must start with http:// or https://" });

export const adminConfigBodySchema = z
  .object({
    banner_enabled: z.boolean(),
    registration_open: z.boolean(),
    banner_image_url: imageUrlSchema.nullable(),
    title: z.string().trim().max(200).nullable(),
    subtitle: z.string().trim().max(400).nullable(),
    cta_label: z.string().trim().max(60).nullable(),
    starts_at: z.string().datetime({ offset: true }).nullable(),
    ends_at: z.string().datetime({ offset: true }).nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "At least one field must be provided" })
  .refine(
    (v) => !(v.starts_at && v.ends_at) || new Date(v.starts_at) < new Date(v.ends_at),
    { message: "starts_at must be before ends_at", path: ["ends_at"] }
  );

export const emailTemplateImageBodySchema = z.object({
  email_banner_image_url: imageUrlSchema.nullable(),
});

export const statusQuerySchema = z.object({
  mobile: z.string().regex(MOBILE_RE).optional(),
});
