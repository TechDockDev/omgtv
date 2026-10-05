import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";

const h = vi.hoisted(() => ({ prisma: null as any, phone: null as string | null }));
vi.mock("../../lib/prisma", () => ({
  getPrismaOptional: () => h.prisma,
  getPrisma: () => h.prisma,
}));
vi.mock("../../lib/redis", () => ({ getRedisOptional: () => null }));
vi.mock("../../clients/user-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../clients/user-client")>()),
  fetchCustomerPhone: vi.fn(async () => h.phone),
}));

import { resetConfigCache } from "../../config";
import { getBanner, invalidateAudienceConfigCache } from "../../services/audience-registration-service";
import { setAudienceStorageForTests } from "../../services/audience-storage";
import { buildPayload, buildTestApp, FakeStorage, groupPdfFile, isDbConnected, submit, TEST_DB_URL } from "./helpers";

let app: FastifyInstance;
let dbAvailable = false;
const prisma = () => h.prisma as PrismaClient;

const T0 = new Date("2026-10-10T12:00:00+05:30");
const STARTS = new Date("2026-10-01T00:00:00+05:30");
const ENDS = new Date("2026-10-20T23:59:59+05:30");

async function setConfig(data: Record<string, unknown>) {
  await prisma().audienceConfig.upsert({
    where: { id: 1 },
    update: data,
    create: { id: 1, ...data },
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
  setAudienceStorageForTests(new FakeStorage());
  h.phone = null;
  invalidateAudienceConfigCache();
});
afterEach(() => {
  delete process.env.AUDIENCE_ALLOW_MOBILE_LOOKUP;
  resetConfigCache();
});

describe("GET /banner", () => {
  it("hides the banner when there is no config row", async () => {
    expect(await getBanner(prisma(), T0)).toEqual({ enabled: false, banner: null });
  });

  it("hides the banner when the admin toggle is off, even inside the window", async () => {
    await setConfig({ bannerEnabled: false, startsAt: STARTS, endsAt: ENDS });
    expect(await getBanner(prisma(), T0)).toEqual({ enabled: false, banner: null });
  });

  it("shows the banner only between starts_at and ends_at", async () => {
    await setConfig({
      bannerEnabled: true,
      bannerImageUrl: "https://cdn.example.com/banners/audience.jpg",
      title: "Be in the audience",
      subtitle: "Groups of 5 or more.",
      ctaLabel: "Register now",
      startsAt: STARTS,
      endsAt: ENDS,
    });
    const inside = await getBanner(prisma(), T0);
    expect(inside.enabled).toBe(true);
    expect(inside.banner).toEqual({
      id: expect.stringMatching(/^bnr_/),
      image_url: "https://cdn.example.com/banners/audience.jpg",
      title: "Be in the audience",
      subtitle: "Groups of 5 or more.",
      cta_label: "Register now",
      registration_open: true,
      starts_at: "2026-10-01T00:00:00+05:30",
      ends_at: "2026-10-20T23:59:59+05:30",
    });

    expect((await getBanner(prisma(), new Date("2026-09-30T23:59:59+05:30"))).enabled).toBe(false);
    expect((await getBanner(prisma(), new Date("2026-10-21T00:00:01+05:30"))).enabled).toBe(false);
  });

  it("keeps showing the banner with registration_open=false once closed", async () => {
    await setConfig({ bannerEnabled: true, startsAt: STARTS, endsAt: ENDS, registrationOpen: false });
    const closed = await getBanner(prisma(), T0);
    expect(closed.enabled).toBe(true);
    expect(closed.banner?.registration_open).toBe(false);
  });

  it("is cached for 60 seconds and refreshed after an admin update", async () => {
    await setConfig({ bannerEnabled: true, title: "First" });
    expect((await getBanner(prisma())).banner?.title).toBe("First");

    // change behind the cache's back
    await prisma().audienceConfig.update({ where: { id: 1 }, data: { title: "Second" } });
    expect((await getBanner(prisma())).banner?.title).toBe("First");

    const patch = await app.inject({
      method: "PATCH",
      url: "/admin/audience/config",
      payload: { title: "Third" },
    });
    expect(patch.statusCode).toBe(200);
    expect((await getBanner(prisma())).banner?.title).toBe("Third");
  });

  it("serves a raw body with a 60s cache header over HTTP", async () => {
    await setConfig({ bannerEnabled: true, title: "Hello" });
    const res = await app.inject({ method: "GET", url: "/client/audience/banner" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=60");
    expect(res.json()).toMatchObject({ enabled: true, banner: { title: "Hello" } });
    expect(res.json()).not.toHaveProperty("success");

    await setConfig({ bannerEnabled: false });
    const off = await app.inject({ method: "GET", url: "/client/audience/banner" });
    expect(off.json()).toEqual({ enabled: false, banner: null });
  });
});

describe("GET /registration/status", () => {
  const ask = (headers: Record<string, string> = {}, qs = "") =>
    app.inject({ method: "GET", url: `/client/audience/registration/status${qs}`, headers });

  async function register(base: number, opts: { userId?: string } = {}) {
    await setConfig({ registrationOpen: true });
    const p = buildPayload(5, base);
    p.lead.full_name = "Rahul Sharma";
    p.lead.mobile = "9876543210";
    const res = await submit(app, p, [await groupPdfFile()], opts);
    expect(res.status).toBe(201);
    return { payload: p, ...res.body };
  }

  it("401 without a login", async () => {
    const res = await ask();
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED");
  });

  it("401 for guests (no phone to match)", async () => {
    const res = await ask({ "x-user-id": "g1", "x-user-type": "GUEST" });
    expect(res.statusCode).toBe(401);
  });

  it("has_filled=false when the user's number is in no group", async () => {
    h.phone = "+91 90000 99999";
    const res = await ask({ "x-user-id": "u1", "x-user-type": "CUSTOMER" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ has_filled: false, registration: null });
  });

  it("finds the group by the user's number when they are the lead", async () => {
    const reg = await register(0);
    h.phone = "+919876543210";
    const res = await ask({ "x-user-id": "u1", "x-user-type": "CUSTOMER" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      has_filled: true,
      registration: {
        registration_id: reg.registration_id,
        reference_id: reg.reference_id,
        status: "RECEIVED",
        group_size: 5,
        lead_name: "Rahul Sharma",
        lead_mobile_masked: "+91 98765 XXXXX",
        city: "Lucknow",
        submitted_at: reg.submitted_at,
        your_role: "LEAD",
        message: expect.stringContaining("pending"),
      },
    });
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });

  it("finds the group when the user is a member, not the lead - without leaking others", async () => {
    const reg = await register(0);
    h.phone = "+91 91000 00003"; // a member's number, formatted with spaces
    const res = await ask({ "x-user-id": "u2", "x-user-type": "CUSTOMER" });
    const body = res.json();
    expect(body.has_filled).toBe(true);
    expect(body.registration.reference_id).toBe(reg.reference_id);
    expect(body.registration.your_role).toBe("MEMBER");
    const text = JSON.stringify(body);
    expect(text).not.toContain("9876543210"); // lead's full number
    expect(text).not.toContain("example.com"); // no emails
    expect(text).not.toContain("9100000002"); // other members' numbers
  });

  it("falls back to the account link when the phone cannot be resolved", async () => {
    const reg = await register(0, { userId: "u-linked" });
    h.phone = null; // UserService unavailable / no phone
    const res = await ask({ "x-user-id": "u-linked", "x-user-type": "CUSTOMER" });
    expect(res.json().registration.reference_id).toBe(reg.reference_id);
  });

  it("reflects admin decisions with a matching message", async () => {
    const reg = await register(0);
    h.phone = "9876543210";
    const headers = { "x-user-id": "u1", "x-user-type": "CUSTOMER" };
    const messages: Record<string, RegExp> = {
      WAITLISTED: /waitlist/i,
      SHORTLISTED: /shortlisted/i,
      NOT_SELECTED: /not selected/i,
      RECEIVED: /pending/i,
    };
    for (const [status, pattern] of Object.entries(messages)) {
      const patch = await app.inject({
        method: "PATCH",
        url: `/admin/audience/registrations/${reg.registration_id}/status`,
        payload: { status },
      });
      expect(patch.statusCode).toBe(200);
      const body = (await ask(headers)).json();
      expect(body.registration.status).toBe(status);
      expect(body.registration.message).toMatch(pattern);
    }
  });

  it("?mobile= is refused unless explicitly enabled", async () => {
    await register(0);
    const refused = await ask({}, "?mobile=9876543210");
    expect(refused.statusCode).toBe(401);

    process.env.AUDIENCE_ALLOW_MOBILE_LOOKUP = "true";
    resetConfigCache();
    const allowed = await ask({}, "?mobile=9876543210");
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().has_filled).toBe(true);
    expect((await ask({}, "?mobile=9000011111")).json().has_filled).toBe(false);
    expect((await ask({}, "?mobile=123")).statusCode).toBe(422);
  });
});

describe("admin API", () => {
  async function seed(n: number) {
    await setConfig({ registrationOpen: true });
    const out: any[] = [];
    for (let i = 0; i < n; i++) {
      const p = buildPayload(5, i * 10);
      p.lead.city = i % 2 === 0 ? "Lucknow" : "Delhi";
      const res = await submit(app, p, [await groupPdfFile()]);
      expect(res.status).toBe(201);
      out.push(res.body);
    }
    return out;
  }

  it("PATCH/GET /config round-trips and validates", async () => {
    const patch = await app.inject({
      method: "PATCH",
      url: "/admin/audience/config",
      payload: {
        banner_enabled: true,
        registration_open: true,
        banner_image_url: "https://cdn.example.com/x.jpg",
        title: "T",
        subtitle: "S",
        cta_label: "Go",
        starts_at: "2026-10-01T00:00:00+05:30",
        ends_at: "2026-10-20T23:59:59+05:30",
      },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({
      banner_enabled: true,
      starts_at: "2026-10-01T00:00:00+05:30",
    });
    expect((await app.inject({ method: "GET", url: "/admin/audience/config" })).json().title).toBe("T");

    const empty = await app.inject({ method: "PATCH", url: "/admin/audience/config", payload: {} });
    expect(empty.statusCode).toBe(422);

    const reversed = await app.inject({
      method: "PATCH",
      url: "/admin/audience/config",
      payload: { ends_at: "2026-09-01T00:00:00+05:30" }, // before the stored starts_at
    });
    expect(reversed.statusCode).toBe(422);
    expect(reversed.json().error.fields).toHaveProperty("ends_at");

    const badUrl = await app.inject({
      method: "PATCH",
      url: "/admin/audience/config",
      payload: { banner_image_url: "not a url" },
    });
    expect(badUrl.statusCode).toBe(422);

    // only http(s) image URLs are storable
    for (const unsafe of ["javascript:alert(1)", "data:image/gif;base64,R0lGODlhAQABAAAAACw=", "file:///etc/passwd"]) {
      const res = await app.inject({
        method: "PATCH",
        url: "/admin/audience/config",
        payload: { banner_image_url: unsafe },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.fields).toHaveProperty("banner_image_url");
    }
  });

  it("a first-ever PATCH creates the config with registration CLOSED unless stated", async () => {
    const first = await app.inject({
      method: "PATCH",
      url: "/admin/audience/config",
      payload: { banner_enabled: true, title: "Hello" },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().registration_open).toBe(false);

    const open = await app.inject({
      method: "PATCH",
      url: "/admin/audience/config",
      payload: { registration_open: true },
    });
    expect(open.json()).toMatchObject({ registration_open: true, title: "Hello", banner_enabled: true });
  });

  it("accepts a GIF (or any image) URL for the banner and serves it unchanged", async () => {
    for (const url of [
      "https://cdn.example.com/banners/audience.gif",
      "https://cdn.example.com/banners/animated.GIF?v=3&w=800",
      "https://cdn.example.com/banners/audience.webp",
    ]) {
      const patch = await app.inject({
        method: "PATCH",
        url: "/admin/audience/config",
        payload: { banner_enabled: true, banner_image_url: url },
      });
      expect(patch.statusCode).toBe(200);
      expect(patch.json().banner_image_url).toBe(url);
      const banner = await app.inject({ method: "GET", url: "/client/audience/banner" });
      expect(banner.json().banner.image_url).toBe(url);
    }
    // clearing it is allowed too
    const cleared = await app.inject({
      method: "PATCH",
      url: "/admin/audience/config",
      payload: { banner_image_url: null },
    });
    expect(cleared.json().banner_image_url).toBeNull();
  });

  it("GET/PATCH /email-template/image stores a pasted link, separate from the app banner", async () => {
    const empty = await app.inject({ method: "GET", url: "/admin/audience/email-template/image" });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ email_banner_image_url: null });

    const url = "https://cdn.example.com/media-library/email-header.jpg";
    const patch = await app.inject({
      method: "PATCH",
      url: "/admin/audience/email-template/image",
      payload: { email_banner_image_url: url },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toEqual({ email_banner_image_url: url });

    const read = await app.inject({ method: "GET", url: "/admin/audience/email-template/image" });
    expect(read.json()).toEqual({ email_banner_image_url: url });

    // Does not touch the app banner's own image field.
    expect((await app.inject({ method: "GET", url: "/admin/audience/config" })).json().banner_image_url).not.toBe(
      url
    );

    // Same http(s)-only rule as the banner URL.
    const unsafe = await app.inject({
      method: "PATCH",
      url: "/admin/audience/email-template/image",
      payload: { email_banner_image_url: "javascript:alert(1)" },
    });
    expect(unsafe.statusCode).toBe(422);
    expect(unsafe.json().error.fields).toHaveProperty("email_banner_image_url");

    // Clearing it is allowed.
    const cleared = await app.inject({
      method: "PATCH",
      url: "/admin/audience/email-template/image",
      payload: { email_banner_image_url: null },
    });
    expect(cleared.json()).toEqual({ email_banner_image_url: null });
  });

  it("lists with status, city and date filters plus pagination", async () => {
    const regs = await seed(4);
    await prisma().audienceRegistration.update({
      where: { id: regs[0].registration_id },
      data: { status: "SHORTLISTED", createdAt: new Date("2026-10-02T10:00:00+05:30") },
    });
    await prisma().audienceRegistration.update({
      where: { id: regs[1].registration_id },
      data: { createdAt: new Date("2026-10-05T10:00:00+05:30") },
    });

    const all = (await app.inject({ method: "GET", url: "/admin/audience/registrations" })).json();
    expect(all.pagination).toEqual({ total: 4, page: 1, limit: 20, totalPages: 1 });
    expect(all.items[0]).toMatchObject({
      reference_id: expect.any(String),
      lead_name: expect.any(String),
      lead_mobile: expect.stringMatching(/^[6-9]\d{9}$/),
      group_size: 5,
    });

    const byStatus = (await app.inject({ method: "GET", url: "/admin/audience/registrations?status=SHORTLISTED" })).json();
    expect(byStatus.items.map((i: any) => i.registration_id)).toEqual([regs[0].registration_id]);

    const byCity = (await app.inject({ method: "GET", url: "/admin/audience/registrations?city=delhi" })).json();
    expect(byCity.pagination.total).toBe(2); // case-insensitive

    const byDate = (await app.inject({ method: "GET", url: "/admin/audience/registrations?from=2026-10-02&to=2026-10-02" })).json();
    expect(byDate.items.map((i: any) => i.registration_id)).toEqual([regs[0].registration_id]);

    const paged = (await app.inject({ method: "GET", url: "/admin/audience/registrations?limit=3&page=2" })).json();
    expect(paged.items).toHaveLength(1);
    expect(paged.pagination).toEqual({ total: 4, page: 2, limit: 3, totalPages: 2 });

    expect((await app.inject({ method: "GET", url: "/admin/audience/registrations?status=BOGUS" })).statusCode).toBe(422);
    expect((await app.inject({ method: "GET", url: "/admin/audience/registrations?limit=1000" })).statusCode).toBe(422);
  });

  it("returns full detail with permanent public URLs for files", async () => {
    const [reg] = await seed(1);
    const res = await app.inject({ method: "GET", url: `/admin/audience/registrations/${reg.registration_id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.members).toHaveLength(5);
    expect(body.members[0]).toMatchObject({ position: 1, email: "person1@example.com" });
    expect(body.consent).toMatchObject({ text_version: "v1" });
    expect(body.files).toHaveLength(1);
    expect(body.files[0].url).toMatch(/^https:\/\/public\.example\/audience\//);
    expect(body.files[0].url_expires_in).toBeNull();

    expect((await app.inject({ method: "GET", url: "/admin/audience/registrations/not-a-uuid" })).statusCode).toBe(422);
    expect(
      (await app.inject({ method: "GET", url: "/admin/audience/registrations/7b6c7b6c-7b6c-4b6c-8b6c-7b6c7b6c7b6c" }))
        .statusCode
    ).toBe(404);
  });

  it("updates status, validating the value and the id", async () => {
    const [reg] = await seed(1);
    const ok = await app.inject({
      method: "PATCH",
      url: `/admin/audience/registrations/${reg.registration_id}/status`,
      payload: { status: "WAITLISTED" },
    });
    expect(ok.json()).toEqual({
      registration_id: reg.registration_id,
      reference_id: reg.reference_id,
      status: "WAITLISTED",
    });
    const bad = await app.inject({
      method: "PATCH",
      url: `/admin/audience/registrations/${reg.registration_id}/status`,
      payload: { status: "APPROVED" },
    });
    expect(bad.statusCode).toBe(422);
    const missing = await app.inject({
      method: "PATCH",
      url: "/admin/audience/registrations/7b6c7b6c-7b6c-4b6c-8b6c-7b6c7b6c7b6c/status",
      payload: { status: "WAITLISTED" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("exports one CSV row per person and neutralizes spreadsheet formulas", async () => {
    await setConfig({ registrationOpen: true });
    const p = buildPayload(5, 0);
    p.lead.full_name = "=HYPERLINK(\"http://evil\")";
    p.members[0].full_name = "+Plus Person";
    expect((await submit(app, p, [await groupPdfFile()])).status).toBe(201);

    const res = await app.inject({ method: "GET", url: "/admin/audience/registrations/export" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="audience-registrations-\d{4}-\d{2}-\d{2}\.csv"$/);

    const lines = res.body.trim().split("\r\n");
    expect(lines[0]).toContain('"reference_id","status"');
    expect(lines.length).toBeGreaterThanOrEqual(1 + 5); // header + people
    expect(res.body).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(res.body).toContain(`"'+Plus Person"`);
    expect(res.body).not.toMatch(/,"=HYPERLINK/);
  });

  it("filters the export like the list does", async () => {
    const regs = await seed(2);
    await prisma().audienceRegistration.update({ where: { id: regs[0].registration_id }, data: { status: "SHORTLISTED" } });
    const res = await app.inject({ method: "GET", url: "/admin/audience/registrations/export?status=SHORTLISTED" });
    const lines = res.body.trim().split("\r\n");
    expect(lines).toHaveLength(1 + 5);
    expect(lines.slice(1).every((l) => l.includes('"SHORTLISTED"'))).toBe(true);
  });
});
