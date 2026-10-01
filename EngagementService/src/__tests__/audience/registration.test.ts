import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import sharp from "sharp";
import type { FastifyInstance } from "fastify";

const h = vi.hoisted(() => ({ prisma: null as any }));
vi.mock("../../lib/prisma", () => ({
  getPrismaOptional: () => h.prisma,
  getPrisma: () => h.prisma,
}));
vi.mock("../../lib/redis", () => ({ getRedisOptional: () => null }));

import { invalidateAudienceConfigCache } from "../../services/audience-registration-service";
import { setAudienceStorageForTests } from "../../services/audience-storage";
import {
  buildPayload,
  buildTestApp,
  FakeStorage,
  groupPdfFile,
  isDbConnected,
  jpegFixture,
  pngFixture,
  submit,
  TEST_DB_URL,
  webpFixture,
  type MultipartFile,
} from "./helpers";

let app: FastifyInstance;
let storage: FakeStorage;
let dbAvailable = false;
const prisma = () => h.prisma as PrismaClient;

const photo = (field: string, data: Buffer, contentType = "image/jpeg"): MultipartFile => ({
  field,
  filename: "p.jpg",
  contentType,
  data,
});

async function openConfig(overrides: Record<string, unknown> = {}) {
  await prisma().audienceConfig.upsert({
    where: { id: 1 },
    update: { registrationOpen: true, startsAt: null, endsAt: null, maxGroups: null, ...overrides },
    create: { id: 1, registrationOpen: true, ...overrides },
  });
  invalidateAudienceConfigCache();
}

beforeAll(async () => {
  h.prisma = new PrismaClient({ datasourceUrl: TEST_DB_URL });
  dbAvailable = await isDbConnected(h.prisma);
  app = await buildTestApp();
});

afterAll(async () => {
  if (app) await app.close();
  if (dbAvailable) await prisma().$disconnect();
  setAudienceStorageForTests(undefined);
});

beforeEach(async (context) => {
  if (!dbAvailable) {
    context.skip();
    return;
  }
  await prisma().$executeRawUnsafe(
    'TRUNCATE "AudienceRegistrationFile","AudienceRegistrationMember","AudienceRegistration","AudienceConfig" CASCADE'
  );
  storage = new FakeStorage();
  setAudienceStorageForTests(storage);
  await openConfig();
});

describe("POST /registration - success", () => {
  it("creates a registration, answers with the contract shape and a raw body", async () => {
    const res = await submit(app, buildPayload(5), [await groupPdfFile()]);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      registration_id: expect.any(String),
      reference_id: expect.stringMatching(/^IFF-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/),
      status: "RECEIVED",
      group_size: 5,
      submitted_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:30$/),
    });
    expect(res.body).not.toHaveProperty("success"); // no gateway-style envelope

    const reg = await prisma().audienceRegistration.findUnique({
      where: { id: res.body.registration_id },
      include: { members: { orderBy: { position: "asc" } }, files: true },
    });
    expect(reg?.members.map((m) => m.position)).toEqual([1, 2, 3, 4, 5]);
    expect(reg?.members[1].email).toBe("person2@example.com");
    expect(reg?.consentVersion).toBe("v1");
    expect(reg?.leadMobile).toBe(reg?.members[0].mobile);
    expect(reg?.files).toHaveLength(1);
    expect(reg?.files[0].kind).toBe("GROUP_PDF");
  });

  it("stores private objects under random keys that contain no personal data", async () => {
    const res = await submit(app, buildPayload(5), [await groupPdfFile()]);
    expect(res.status).toBe(201);
    const keys = [...storage.objects.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^audience\/\d{4}-\d{2}\/[0-9a-f-]{36}\.pdf$/);
    expect(keys[0]).not.toMatch(/9100000/); // no mobile digits
  });

  it("accepts photos for everyone (mixed JPEG/PNG/WebP) without a PDF", async () => {
    const payload = buildPayload(5, 0, {
      photos_provided: ["lead", "member_2", "member_3", "member_4", "member_5"],
      group_pdf_provided: false,
    });
    const files = [
      photo("photo_lead", await jpegFixture(), "image/jpeg"),
      photo("photo_member_2", await pngFixture(), "image/png"),
      photo("photo_member_3", await webpFixture(), "image/webp"),
      photo("photo_member_4", await jpegFixture()),
      photo("photo_member_5", await pngFixture(), "image/png"),
    ];
    const res = await submit(app, payload, files);
    expect(res.status).toBe(201);

    const members = await prisma().audienceRegistrationMember.findMany({
      where: { registrationId: res.body.registration_id },
    });
    expect(members.every((m) => m.photoFileId)).toBe(true);
    expect(storage.objects.size).toBe(5);
  });

  it("strips EXIF metadata from stored images", async () => {
    const original = await jpegFixture(true);
    expect((await sharp(original).metadata()).exif).toBeDefined(); // fixture really has EXIF

    const payload = buildPayload(5, 0, {
      photos_provided: ["lead", "member_2", "member_3", "member_4", "member_5"],
      group_pdf_provided: false,
    });
    const files = ["photo_lead", "photo_member_2", "photo_member_3", "photo_member_4", "photo_member_5"].map(
      (field) => photo(field, original)
    );
    const res = await submit(app, payload, files);
    expect(res.status).toBe(201);

    for (const { body } of storage.objects.values()) {
      const meta = await sharp(body).metadata();
      expect(meta.exif).toBeUndefined();
      expect(body.includes(Buffer.from("SECRET-GPS-OWNER"))).toBe(false);
    }
  });

  it("accepts a 10 person group with a mix of a few photos and the PDF", async () => {
    const payload = buildPayload(10, 0, { photos_provided: ["lead", "member_7"] });
    const res = await submit(app, payload, [
      photo("photo_lead", await jpegFixture()),
      photo("photo_member_7", await pngFixture(), "image/png"),
      await groupPdfFile(),
    ]);
    expect(res.status).toBe(201);
    expect(res.body.group_size).toBe(10);
    expect(storage.objects.size).toBe(3);
  });

  it("links the registration to the logged-in customer only", async () => {
    const guest = await submit(app, buildPayload(5, 0), [await groupPdfFile()], {
      userId: "guest-1",
      userType: "GUEST",
    });
    expect(guest.status).toBe(201);
    const guestReg = await prisma().audienceRegistration.findUnique({ where: { id: guest.body.registration_id } });
    expect(guestReg?.userId).toBeNull();

    const customer = await submit(app, buildPayload(5, 100), [await groupPdfFile()], { userId: "user-1" });
    const customerReg = await prisma().audienceRegistration.findUnique({
      where: { id: customer.body.registration_id },
    });
    expect(customerReg?.userId).toBe("user-1");
  });
});

describe("POST /registration - validation", () => {
  it("returns the shared error shape with indexed field names", async () => {
    const p = buildPayload(5);
    p.members[1].mobile = "12345";
    p.members[3].email = "nope";
    const res = await submit(app, p, [await groupPdfFile()]);
    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: {
        code: "VALIDATION_FAILED",
        message: "Please fix the highlighted fields.",
        fields: {
          "members[1].mobile": "Enter a 10-digit mobile number starting with 6, 7, 8 or 9",
          "members[3].email": "Enter a valid email, like name@example.com",
        },
      },
    });
  });

  it("422 GROUP_TOO_SMALL / GROUP_TOO_LARGE", async () => {
    const small = await submit(app, buildPayload(4), [await groupPdfFile()]);
    expect([small.status, small.body.error.code]).toEqual([422, "GROUP_TOO_SMALL"]);
    const large = await submit(app, buildPayload(11), [await groupPdfFile()]);
    expect([large.status, large.body.error.code]).toEqual([422, "GROUP_TOO_LARGE"]);
  });

  it("requires a payload part and multipart content", async () => {
    const missing = await submit(app, undefined, []);
    expect(missing.status).toBe(422);
    expect(missing.body.error.fields).toHaveProperty("payload");

    const notMultipart = await app.inject({
      method: "POST",
      url: "/client/audience/registration",
      headers: { "content-type": "application/json", "idempotency-key": "abcdefgh1234" },
      payload: JSON.stringify(buildPayload(5)),
    });
    expect(notMultipart.statusCode).toBe(422);
    expect(notMultipart.json().error.code).toBe("VALIDATION_FAILED");
  });

  it("rejects unexpected file fields", async () => {
    const res = await submit(app, buildPayload(5), [
      await groupPdfFile(),
      { field: "resume", filename: "r.pdf", contentType: "application/pdf", data: Buffer.from("%PDF-1.4") },
    ]);
    expect(res.status).toBe(422);
    expect(res.body.error.fields).toHaveProperty("files");
  });

  it("rejects a photo field for a position outside the group", async () => {
    const res = await submit(
      app,
      buildPayload(5, 0, { photos_provided: ["lead"] }),
      [photo("photo_member_9", await jpegFixture()), photo("photo_lead", await jpegFixture()), await groupPdfFile()]
    );
    expect(res.status).toBe(422);
  });
});

describe("POST /registration - photo or PDF rule", () => {
  it("422 PHOTO_OR_PDF_REQUIRED lists everyone missing a photo", async () => {
    const payload = buildPayload(5, 0, { photos_provided: ["lead"], group_pdf_provided: false });
    const res = await submit(app, payload, [photo("photo_lead", await jpegFixture())]);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("PHOTO_OR_PDF_REQUIRED");
    expect(Object.keys(res.body.error.fields).sort()).toEqual([
      "members[0].photo",
      "members[1].photo",
      "members[2].photo",
      "members[3].photo",
    ]);
  });

  it("a PDF covers everyone even with zero photos", async () => {
    const res = await submit(app, buildPayload(5), [await groupPdfFile()]);
    expect(res.status).toBe(201);
  });

  it("photos_provided must match what was attached", async () => {
    const declaredNotSent = await submit(
      app,
      buildPayload(5, 0, { photos_provided: ["lead"] }),
      [await groupPdfFile()]
    );
    expect(declaredNotSent.status).toBe(422);
    expect(declaredNotSent.body.error.fields).toHaveProperty("photos_provided");

    const sentNotDeclared = await submit(app, buildPayload(5, 100), [
      photo("photo_lead", await jpegFixture()),
      await groupPdfFile(),
    ]);
    expect(sentNotDeclared.status).toBe(422);
    expect(sentNotDeclared.body.error.fields).toHaveProperty("photos_provided");
  });

  it("group_pdf_provided must match the attachment", async () => {
    const claimedNoFile = await submit(app, buildPayload(5), []);
    expect(claimedNoFile.status).toBe(422);
    expect(claimedNoFile.body.error.fields).toHaveProperty("group_pdf_provided");

    const fileNotClaimed = await submit(
      app,
      buildPayload(5, 100, { group_pdf_provided: false }),
      [await groupPdfFile()]
    );
    expect(fileNotClaimed.status).toBe(422);
    expect(fileNotClaimed.body.error.fields).toHaveProperty("group_pdf_provided");
  });
});

describe("POST /registration - files", () => {
  it("415 when a text file pretends to be a JPEG (magic bytes win)", async () => {
    const payload = buildPayload(5, 0, {
      photos_provided: ["lead", "member_2", "member_3", "member_4", "member_5"],
      group_pdf_provided: false,
    });
    const fake = Buffer.from("this is definitely not an image");
    const good = await jpegFixture();
    const files = [
      photo("photo_lead", fake, "image/jpeg"),
      ...["photo_member_2", "photo_member_3", "photo_member_4", "photo_member_5"].map((f) => photo(f, good)),
    ];
    const res = await submit(app, payload, files);
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe("UNSUPPORTED_FILE");
    expect(storage.objects.size).toBe(0);
  });

  it("415 for a PDF sent as a photo and an image sent as the group PDF", async () => {
    const asPhoto = await submit(app, buildPayload(5, 0, { photos_provided: ["lead"] }), [
      photo("photo_lead", Buffer.from("%PDF-1.4 fake"), "image/jpeg"),
      await groupPdfFile(),
    ]);
    expect(asPhoto.status).toBe(415);

    const asPdf = await submit(app, buildPayload(5, 100), [
      { field: "group_pdf", filename: "g.pdf", contentType: "application/pdf", data: await jpegFixture() },
    ]);
    expect(asPdf.status).toBe(415);
  });

  it("413 FILE_TOO_LARGE for an image over 5 MB", async () => {
    const big = Buffer.concat([await jpegFixture(), Buffer.alloc(5 * 1024 * 1024 + 1024)]);
    const res = await submit(app, buildPayload(5, 0, { photos_provided: ["lead"] }), [
      photo("photo_lead", big),
      await groupPdfFile(),
    ]);
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("FILE_TOO_LARGE");
    expect(storage.objects.size).toBe(0);
  });

  it("413 FILE_TOO_LARGE for a PDF over 10 MB", async () => {
    const bigPdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(10 * 1024 * 1024 + 2048)]);
    const res = await submit(app, buildPayload(5), [
      { field: "group_pdf", filename: "g.pdf", contentType: "application/pdf", data: bigPdf },
    ]);
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("FILE_TOO_LARGE");
  });

  it("415 for a corrupt image with a valid header, and nothing is left in storage", async () => {
    const payload = buildPayload(5, 0, {
      photos_provided: ["lead", "member_2", "member_3", "member_4", "member_5"],
      group_pdf_provided: false,
    });
    const corrupt = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("garbage-not-a-jpeg")]);
    const good = await jpegFixture();
    const res = await submit(app, payload, [
      photo("photo_lead", good),
      photo("photo_member_2", good),
      photo("photo_member_3", good),
      photo("photo_member_4", good),
      photo("photo_member_5", corrupt),
    ]);
    expect(res.status).toBe(415);
    expect(storage.objects.size).toBe(0);
    expect(await prisma().audienceRegistration.count()).toBe(0);
  });

  it("removes already-uploaded files when storage fails midway (500, no row)", async () => {
    storage.failPutOnCall = 3;
    const payload = buildPayload(5, 0, {
      photos_provided: ["lead", "member_2", "member_3", "member_4", "member_5"],
      group_pdf_provided: false,
    });
    const good = await jpegFixture();
    const res = await submit(
      app,
      payload,
      ["photo_lead", "photo_member_2", "photo_member_3", "photo_member_4", "photo_member_5"].map((f) =>
        photo(f, good)
      )
    );
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(res.body)).not.toMatch(/simulated storage outage/);
    expect(storage.objects.size).toBe(0);
    expect(await prisma().audienceRegistration.count()).toBe(0);
  });

  it("503 when no bucket is configured (rather than silently dropping files)", async () => {
    setAudienceStorageForTests(null);
    const res = await submit(app, buildPayload(5), [await groupPdfFile()]);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("SERVICE_UNAVAILABLE");
  });
});

describe("POST /registration - idempotency", () => {
  it("replays the original response for the same key without creating anything new", async () => {
    const payload = buildPayload(5);
    const first = await submit(app, payload, [await groupPdfFile()], { key: "key-12345678" });
    const objectsAfterFirst = storage.objects.size;
    const second = await submit(app, payload, [await groupPdfFile()], { key: "key-12345678" });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(await prisma().audienceRegistration.count()).toBe(1);
    expect(storage.objects.size).toBe(objectsAfterFirst);
  });

  it("falls back to client_request_id when the header is missing", async () => {
    const payload = buildPayload(5);
    const first = await submit(app, payload, [await groupPdfFile()], { key: null });
    const second = await submit(app, payload, [await groupPdfFile()], { key: null });
    expect(first.status).toBe(201);
    expect(second.body.registration_id).toBe(first.body.registration_id);
  });

  it("422 when there is neither a header nor client_request_id", async () => {
    const payload: any = buildPayload(5);
    delete payload.client_request_id;
    const res = await submit(app, payload, [await groupPdfFile()], { key: null });
    expect(res.status).toBe(422);
    expect(res.body.error.fields).toHaveProperty(["Idempotency-Key"]);
  });

  it("422 when a key is reused for a different lead", async () => {
    await submit(app, buildPayload(5, 0), [await groupPdfFile()], { key: "shared-key-1234" });
    const res = await submit(app, buildPayload(5, 100), [await groupPdfFile()], { key: "shared-key-1234" });
    expect(res.status).toBe(422);
    expect(res.body.error.fields).toHaveProperty(["Idempotency-Key"]);
    expect(await prisma().audienceRegistration.count()).toBe(1);
  });

  it("concurrent requests with the same key create exactly one registration", async () => {
    const payload = buildPayload(5);
    const results = await Promise.all(
      Array.from({ length: 4 }, async () => submit(app, payload, [await groupPdfFile()], { key: "race-key-123456" }))
    );
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    expect(new Set(results.map((r) => r.body.registration_id)).size).toBe(1);
    expect(await prisma().audienceRegistration.count()).toBe(1);
    expect(storage.objects.size).toBe(1); // losers' uploads were cleaned up
  });
});

describe("POST /registration - duplicates", () => {
  const named = (base: number, name: string, email: string) => {
    const p = buildPayload(5, base);
    p.lead.full_name = name;
    p.lead.email = email;
    return p;
  };

  it("409 DUPLICATE_MOBILE for a member of another group - position only, no data leak", async () => {
    const a = await submit(app, named(0, "Alpha Secretname", "alpha.secret@example.com"), [await groupPdfFile()]);
    expect(a.status).toBe(201);

    const b = buildPayload(5, 100);
    b.members[2].mobile = buildPayload(5, 0).members[1].mobile; // belongs to group A
    const res = await submit(app, b, [await groupPdfFile()]);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("DUPLICATE_MOBILE");
    expect(Object.keys(res.body.error.fields)).toEqual(["members[2].mobile"]);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("Alpha");
    expect(serialized).not.toContain("alpha.secret");
    expect(serialized).not.toContain(a.body.reference_id);
    expect(serialized).not.toContain(a.body.registration_id);
    expect(await prisma().audienceRegistration.count()).toBe(1);
  });

  it("409 when the lead's mobile is already a lead elsewhere, without revealing the reference", async () => {
    const a = await submit(app, buildPayload(5, 0), [await groupPdfFile()]);
    const retry = buildPayload(5, 0); // same people, brand new request, anonymous
    const res = await submit(app, retry, [await groupPdfFile()]);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("DUPLICATE_MOBILE");
    expect(res.body.error.fields).toHaveProperty(["lead.mobile"]);
    expect(JSON.stringify(res.body)).not.toContain(a.body.reference_id);
  });

  it("409 ALREADY_REGISTERED with the existing reference for the same logged-in user", async () => {
    const first = await submit(app, buildPayload(5, 0), [await groupPdfFile()], { userId: "user-42" });
    // different people, same account
    const res = await submit(app, buildPayload(5, 100), [await groupPdfFile()], { userId: "user-42" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ALREADY_REGISTERED");
    expect(res.body.error.reference_id).toBe(first.body.reference_id);
  });

  it("ALREADY_REGISTERED also when the same account resubmits the same lead mobile", async () => {
    const first = await submit(app, buildPayload(5, 0), [await groupPdfFile()], { userId: "user-7" });
    const res = await submit(app, buildPayload(5, 0), [await groupPdfFile()], { userId: "user-7" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ALREADY_REGISTERED");
    expect(res.body.error.reference_id).toBe(first.body.reference_id);
  });

  it("concurrent submissions of the same people create exactly one registration", async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, async () => submit(app, buildPayload(5, 0), [await groupPdfFile()]))
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    expect(await prisma().audienceRegistration.count()).toBe(1);
    expect(storage.objects.size).toBe(1);
  });
});

describe("POST /registration - closed / capacity", () => {
  it("403 when registration_open is off", async () => {
    await openConfig({ registrationOpen: false });
    const res = await submit(app, buildPayload(5), [await groupPdfFile()]);
    expect([res.status, res.body.error.code]).toEqual([403, "REGISTRATION_CLOSED"]);
    expect(storage.objects.size).toBe(0);
  });

  it("403 after the window ended and before it starts", async () => {
    await openConfig({ endsAt: new Date(Date.now() - 60_000) });
    expect((await submit(app, buildPayload(5), [await groupPdfFile()])).status).toBe(403);

    await openConfig({ startsAt: new Date(Date.now() + 3_600_000), endsAt: null });
    expect((await submit(app, buildPayload(5, 100), [await groupPdfFile()])).status).toBe(403);
  });

  it("403 when no config exists at all", async () => {
    await prisma().audienceConfig.deleteMany();
    invalidateAudienceConfigCache();
    const res = await submit(app, buildPayload(5), [await groupPdfFile()]);
    expect(res.status).toBe(403);
  });

  it("403 once max_groups is reached", async () => {
    await openConfig({ maxGroups: 1 });
    expect((await submit(app, buildPayload(5, 0), [await groupPdfFile()])).status).toBe(201);
    const res = await submit(app, buildPayload(5, 100), [await groupPdfFile()]);
    expect([res.status, res.body.error.code]).toEqual([403, "REGISTRATION_CLOSED"]);
  });

  it("never exceeds max_groups under concurrent submissions", async () => {
    await openConfig({ maxGroups: 3 });
    const results = await Promise.all(
      Array.from({ length: 6 }, async (_v, i) =>
        submit(app, buildPayload(5, (i + 1) * 100), [await groupPdfFile()])
      )
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(3);
    expect(statuses.filter((s) => s === 403)).toHaveLength(3);
    expect(await prisma().audienceRegistration.count()).toBe(3);
    // the 3 rejected groups must not leave files behind
    expect(storage.objects.size).toBe(3);
  });
});
