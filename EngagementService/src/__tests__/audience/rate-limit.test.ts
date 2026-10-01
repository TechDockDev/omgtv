import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";

const h = vi.hoisted(() => ({
  prisma: null as any,
  redis: null as any,
}));
vi.mock("../../lib/prisma", () => ({
  getPrismaOptional: () => h.prisma,
  getPrisma: () => h.prisma,
}));
vi.mock("../../lib/redis", () => ({ getRedisOptional: () => h.redis }));

import { invalidateAudienceConfigCache } from "../../services/audience-registration-service";
import { setAudienceStorageForTests } from "../../services/audience-storage";
import { buildPayload, buildTestApp, FakeStorage, groupPdfFile, isDbConnected, submit, TEST_DB_URL } from "./helpers";

class FakeRedis {
  counters = new Map<string, number>();
  expiries = new Map<string, number>();
  broken = false;
  async incr(key: string) {
    if (this.broken) throw new Error("redis down");
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return next;
  }
  async expire(key: string, seconds: number) {
    this.expiries.set(key, seconds);
    return 1;
  }
}

let app: FastifyInstance;
let dbAvailable = false;
const prisma = () => h.prisma as PrismaClient;

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
  await prisma().audienceConfig.create({ data: { id: 1, registrationOpen: true } });
  invalidateAudienceConfigCache();
  setAudienceStorageForTests(new FakeStorage());
  h.redis = new FakeRedis();
});

describe("per-mobile rate limit", () => {
  it("429 RATE_LIMITED after 5 attempts for the same lead mobile within the window", async () => {
    const payload = buildPayload(5, 0);
    const first = await submit(app, payload, [await groupPdfFile()]);
    expect(first.status).toBe(201);

    // attempts 2..5 are real attempts that hit the duplicate check
    for (let i = 0; i < 4; i++) {
      const res = await submit(app, payload, [await groupPdfFile()]);
      expect(res.status).toBe(409);
    }
    const blocked = await submit(app, payload, [await groupPdfFile()]);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
    expect(h.redis.expiries.get("audience:submit:" + payload.lead.mobile)).toBe(3600);
  });

  it("does not count validation failures against the limit", async () => {
    const payload = buildPayload(5, 0);
    payload.lead.email = "broken";
    for (let i = 0; i < 8; i++) {
      expect((await submit(app, payload, [await groupPdfFile()])).status).toBe(422);
    }
    expect(h.redis.counters.size).toBe(0);
    payload.lead.email = "fixed@example.com";
    expect((await submit(app, payload, [await groupPdfFile()])).status).toBe(201);
  });

  it("limits each lead mobile separately", async () => {
    const a = buildPayload(5, 0);
    const b = buildPayload(5, 100);
    for (let i = 0; i < 5; i++) await submit(app, a, [await groupPdfFile()]);
    expect((await submit(app, a, [await groupPdfFile()])).status).toBe(429);
    expect((await submit(app, b, [await groupPdfFile()])).status).toBe(201);
  });

  it("an idempotent replay does not consume attempts", async () => {
    const payload = buildPayload(5, 0);
    for (let i = 0; i < 12; i++) {
      const res = await submit(app, payload, [await groupPdfFile()], { key: "same-key-123456" });
      expect(res.status).toBe(201);
    }
    expect(h.redis.counters.get("audience:submit:" + payload.lead.mobile)).toBe(1);
  });

  it("fails open when Redis is down, and works without Redis at all", async () => {
    h.redis.broken = true;
    expect((await submit(app, buildPayload(5, 0), [await groupPdfFile()])).status).toBe(201);
    h.redis = null;
    expect((await submit(app, buildPayload(5, 100), [await groupPdfFile()])).status).toBe(201);
  });
});
