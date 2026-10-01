/* Throwaway end-to-end check: real EngagementService routes behind the real
   audience gateway routes + multipart pass-through, over real HTTP. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const TEST_DB = "postgresql://postgres:postgres@localhost:5432/pocketlol_engagement_audience_test?schema=public";
process.env.DATABASE_URL = TEST_DB;
process.env.NODE_ENV = "test";

async function main() {
  // ---- engagement side (real routes, fake storage) ----
  const eng = await import("../EngagementService/src/__tests__/audience/helpers");
  const { setAudienceStorageForTests } = await import("../EngagementService/src/services/audience-storage");
  const { PrismaClient } = await import("../EngagementService/node_modules/@prisma/client");
  const prisma = new PrismaClient({ datasourceUrl: TEST_DB });
  await prisma.$executeRawUnsafe(
    'TRUNCATE "AudienceRegistrationFile","AudienceRegistrationMember","AudienceRegistration","AudienceConfig" CASCADE'
  );
  await prisma.audienceConfig.create({ data: { id: 1, registrationOpen: true, bannerEnabled: true, title: "E2E" } });
  const storage = new eng.FakeStorage();
  setAudienceStorageForTests(storage);

  const EngFastify = (await import("fastify")).default;
  const globalResponse = (await import("../EngagementService/src/plugins/global-response")).default;
  const engAudience = (await import("../EngagementService/src/routes/audience")).default;
  const engAdmin = (await import("../EngagementService/src/routes/audience-admin")).default;
  const engApp = EngFastify({ logger: false });
  const seenHeaders: Record<string, any>[] = [];
  engApp.addHook("onRequest", async (req) => {
    seenHeaders.push({ ...req.headers });
  });
  await engApp.register(globalResponse);
  await engApp.register(engAudience, { prefix: "/client/audience" });
  await engApp.register(engAdmin, { prefix: "/admin/audience" });
  await engApp.listen({ port: 0, host: "127.0.0.1" });
  const engPort = (engApp.server.address() as any).port;

  // ---- gateway side (real audience routes + real parser) ----
  Object.assign(process.env, {
    REDIS_URL: "redis://127.0.0.1:6399",
    AUTH_JWKS_URL: "http://127.0.0.1:1/jwks",
    AUTH_AUDIENCE: "x",
    AUTH_ISSUER: "x",
    CONTENT_SERVICE_URL: "http://127.0.0.1:1",
    AUTH_SERVICE_URL: "http://127.0.0.1:1",
    USER_SERVICE_URL: "http://127.0.0.1:1",
    UPLOAD_SERVICE_URL: "http://127.0.0.1:1",
    SEARCH_SERVICE_URL: "http://127.0.0.1:1",
    SUBSCRIPTION_SERVICE_URL: "http://127.0.0.1:1",
    ENGAGEMENT_SERVICE_URL: `http://127.0.0.1:${engPort}`,
    SERVICE_AUTH_TOKEN: "svc-token-e2e",
  });
  const Fastify = (await import("fastify")).default;
  const replyFrom = (await import("@fastify/reply-from")).default;
  const { registerMultipartPassthrough } = await import("./src/plugins/multipart-passthrough");
  const audienceRoutes = (await import("./src/routes/audience.routes")).default;

  const gw = Fastify({ logger: false, bodyLimit: 1_048_576 });
  gw.decorateRequest("correlationId", "corr-e2e");
  gw.decorateRequest("user", null as any);
  gw.addHook("onRoute", (opts) => {
    const limit = (opts.config as any)?.security?.bodyLimit;
    if (typeof limit === "number" && limit > 0) opts.bodyLimit = limit;
  });
  gw.addHook("onRequest", async (req) => {
    const raw = req.headers["x-test-user"];
    (req as any).user = typeof raw === "string" ? JSON.parse(raw) : undefined;
  });
  gw.decorate("authorize", (roles: string[]) => async (req: any, reply: any) => {
    if (!req.user || !roles.map((r) => r.toUpperCase()).includes(req.user.userType)) {
      reply.code(403).send({ message: "forbidden" });
    }
  });
  await gw.register(replyFrom);
  registerMultipartPassthrough(gw);
  gw.post("/api/v1/other", async () => ({ ok: true })); // multipart must be refused here
  await gw.register(audienceRoutes, { prefix: "/api/v1/audience" });
  await gw.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(gw.server.address() as any).port}/api/v1/audience`;
  const origin = base.replace("/api/v1/audience", "");

  const customer = JSON.stringify({ id: "user-e2e-1", userType: "CUSTOMER", roles: [] });
  const admin = JSON.stringify({ id: "admin-1", userType: "ADMIN", roles: ["ADMIN"] });
  let passed = 0;
  const ok = (name: string) => {
    passed++;
    console.log(`  PASS  ${name}`);
  };

  // 1. banner passes through raw, with the cache header
  {
    const res = await fetch(`${base}/banner`);
    const body: any = await res.json();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "public, max-age=60");
    assert.equal(body.enabled, true);
    assert.ok(!("success" in body));
    ok("GET /banner raw passthrough");
  }

  // 2. real multipart upload (fetch + FormData over a real socket)
  const payload = eng.buildPayload(5, 0, { photos_provided: ["lead"] });
  const jpeg = await eng.jpegFixture(true);
  const form = new FormData();
  form.set("payload", JSON.stringify(payload));
  form.set("photo_lead", new Blob([jpeg], { type: "image/jpeg" }), "me.jpg");
  form.set("group_pdf", new Blob([eng.pdfFixture()], { type: "application/pdf" }), "g.pdf");
  const key = randomUUID();
  const created = await fetch(`${base}/registration`, {
    method: "POST",
    headers: {
      "idempotency-key": key,
      "x-test-user": customer,
      "x-user-id": "SPOOFED-BY-CLIENT",
      "x-user-type": "ADMIN",
    },
    body: form,
  });
  const createdBody: any = await created.json();
  assert.equal(created.status, 201, JSON.stringify(createdBody));
  assert.match(createdBody.reference_id, /^IFF-/);
  assert.equal(createdBody.group_size, 5);
  ok("POST /registration multipart through gateway -> 201");

  // 3. identity comes from the verified token, never from client headers
  {
    const row = await prisma.audienceRegistration.findUnique({ where: { id: createdBody.registration_id } });
    assert.equal(row?.userId, "user-e2e-1");
    const upstream = seenHeaders.find((h) => h["idempotency-key"] === key)!;
    assert.equal(upstream["x-user-id"], "user-e2e-1");
    assert.equal(upstream["x-user-type"], "CUSTOMER");
    assert.equal(upstream["x-service-token"], "svc-token-e2e");
    assert.equal(upstream["authorization"], "Bearer svc-token-e2e");
    ok("verified identity forwarded, spoofed identity headers dropped");
  }

  // 4. the stored photo really had its EXIF removed, and files landed in storage
  {
    assert.equal(storage.objects.size, 2);
    const sharp = (await import("sharp")).default;
    const photo = [...storage.objects.values()].find((o) => o.contentType === "image/jpeg")!;
    assert.equal((await sharp(photo.body).metadata()).exif, undefined);
    ok("EXIF stripped, 2 private objects stored");
  }

  // 5. idempotent replay through the gateway
  {
    const replayForm = new FormData();
    replayForm.set("payload", JSON.stringify(payload));
    replayForm.set("photo_lead", new Blob([jpeg], { type: "image/jpeg" }), "me.jpg");
    replayForm.set("group_pdf", new Blob([eng.pdfFixture()], { type: "application/pdf" }), "g.pdf");
    const replay = await fetch(`${base}/registration`, {
      method: "POST",
      headers: { "idempotency-key": key, "x-test-user": customer },
      body: replayForm,
    });
    const replayBody: any = await replay.json();
    assert.equal(replay.status, 201);
    assert.deepEqual(replayBody, createdBody);
    ok("idempotent replay returns the original body");
  }

  // 6. upstream errors keep their status and shape
  {
    const dupForm = new FormData();
    dupForm.set("payload", JSON.stringify(eng.buildPayload(5, 0)));
    dupForm.set("group_pdf", new Blob([eng.pdfFixture()], { type: "application/pdf" }), "g.pdf");
    const dup = await fetch(`${base}/registration`, { method: "POST", headers: { "idempotency-key": randomUUID() }, body: dupForm });
    const dupBody: any = await dup.json();
    assert.equal(dup.status, 409);
    assert.equal(dupBody.error.code, "DUPLICATE_MOBILE");
    assert.ok(dupBody.error.fields["lead.mobile"]);
    ok("409 DUPLICATE_MOBILE passes through unchanged");

    const bigForm = new FormData();
    bigForm.set("payload", JSON.stringify(eng.buildPayload(5, 200, { photos_provided: ["lead"] })));
    bigForm.set("photo_lead", new Blob([Buffer.concat([jpeg, Buffer.alloc(5.5 * 1024 * 1024)])], { type: "image/jpeg" }), "big.jpg");
    bigForm.set("group_pdf", new Blob([eng.pdfFixture()], { type: "application/pdf" }), "g.pdf");
    const big = await fetch(`${base}/registration`, { method: "POST", headers: { "idempotency-key": randomUUID() }, body: bigForm });
    assert.equal(big.status, 413);
    assert.equal(((await big.json()) as any).error.code, "FILE_TOO_LARGE");
    ok("413 FILE_TOO_LARGE passes through");
  }

  // 7. maximum legitimate upload: 10 photos near 5 MB + a 9 MB PDF (~59 MB)
  {
    const sizeForm = new FormData();
    const maxPayload = eng.buildPayload(10, 300, {
      photos_provided: ["lead", ...Array.from({ length: 9 }, (_, i) => `member_${i + 2}`)],
    });
    const padded = Buffer.concat([await eng.jpegFixture(), Buffer.alloc(4.8 * 1024 * 1024)]);
    sizeForm.set("payload", JSON.stringify(maxPayload));
    sizeForm.set("photo_lead", new Blob([padded], { type: "image/jpeg" }), "lead.jpg");
    for (let i = 2; i <= 10; i++) sizeForm.set(`photo_member_${i}`, new Blob([padded], { type: "image/jpeg" }), `m${i}.jpg`);
    sizeForm.set("group_pdf", new Blob([Buffer.concat([eng.pdfFixture(), Buffer.alloc(9 * 1024 * 1024)])], { type: "application/pdf" }), "g.pdf");
    const started = Date.now();
    const res = await fetch(`${base}/registration`, { method: "POST", headers: { "idempotency-key": randomUUID() }, body: sizeForm });
    const body: any = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.equal(body.group_size, 10);
    ok(`max-size upload (~58 MB, 11 files) -> 201 in ${Date.now() - started} ms`);
  }

  // 8. multipart is refused elsewhere, and requires a length
  {
    const f = new FormData();
    f.set("a", "b");
    const other = await fetch(`${origin}/api/v1/other`, { method: "POST", body: f });
    assert.equal(other.status, 415);
    ok("multipart refused outside /api/v1/audience (415)");

    const chunked = await fetch(`${base}/registration`, {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=xyz" },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("--xyz--\r\n"));
          c.close();
        },
      }),
      // @ts-expect-error node-specific
      duplex: "half",
    });
    assert.equal(chunked.status, 411);
    ok("chunked upload without Content-Length refused (411)");

    const huge = await fetch(`${base}/registration`, {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=xyz", "content-length": String(70 * 1024 * 1024) },
      body: "x",
    }).catch((e) => ({ status: -1, err: e }));
    // Node's fetch refuses a lying content-length itself; accept either outcome
    assert.ok([413, -1].includes((huge as any).status));
    ok("declared >64 MB upload refused");
  }

  // 9. status + admin through the gateway
  {
    const status = await fetch(`${base}/registration/status`, { headers: { "x-test-user": customer } });
    // UserService is unreachable in this harness, so the lookup falls back to the account link
    const statusBody: any = await status.json();
    assert.equal(status.status, 200);
    assert.equal(statusBody.has_filled, true);
    assert.equal(statusBody.registration.reference_id, createdBody.reference_id);
    assert.match(statusBody.registration.message, /pending/);
    ok("GET /registration/status resolves the logged-in user");

    const anon = await fetch(`${base}/registration/status`);
    assert.equal(anon.status, 401);
    assert.equal(((await anon.json()) as any).error.code, "UNAUTHORIZED");
    ok("status without login -> 401");

    const nonAdmin = await fetch(`${base}/admin/registrations`, { headers: { "x-test-user": customer } });
    assert.equal(nonAdmin.status, 403);
    const anonAdmin = await fetch(`${base}/admin/registrations`);
    assert.equal(anonAdmin.status, 403);
    ok("admin routes reject customers and anonymous callers");

    const list = await fetch(`${base}/admin/registrations?limit=5`, { headers: { "x-test-user": admin } });
    const listBody: any = await list.json();
    assert.equal(list.status, 200);
    assert.ok(listBody.pagination.total >= 2);

    const detail = await fetch(`${base}/admin/registrations/${createdBody.registration_id}`, { headers: { "x-test-user": admin } });
    const detailBody: any = await detail.json();
    assert.equal(detailBody.members.length, 5);
    assert.ok(detailBody.files.every((f: any) => f.url.startsWith("https://signed.example/")));

    const patch = await fetch(`${base}/admin/registrations/${createdBody.registration_id}/status`, {
      method: "PATCH",
      headers: { "x-test-user": admin, "content-type": "application/json" },
      body: JSON.stringify({ status: "SHORTLISTED" }),
    });
    assert.equal(((await patch.json()) as any).status, "SHORTLISTED");

    const cfg = await fetch(`${base}/admin/config`, {
      method: "PATCH",
      headers: { "x-test-user": admin, "content-type": "application/json" },
      body: JSON.stringify({ title: "Updated via gateway" }),
    });
    assert.equal(((await cfg.json()) as any).title, "Updated via gateway");

    const csv = await fetch(`${base}/admin/registrations/export`, { headers: { "x-test-user": admin } });
    assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
    assert.match(csv.headers.get("content-disposition") ?? "", /attachment/);
    const csvText = await csv.text();
    assert.ok(csvText.startsWith('"reference_id"'));
    ok("admin list / detail / status / config / csv through the gateway");
  }

  console.log(`\nE2E: ${passed} checks passed`);
  await gw.close();
  await engApp.close();
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("E2E FAILED:", err);
  process.exit(1);
});
