import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import sharp from "sharp";
import globalResponsePlugin from "../../plugins/global-response";
import audienceRoutes from "../../routes/audience";
import audienceAdminRoutes from "../../routes/audience-admin";
import type { AudienceFileStorage } from "../../services/audience-storage";

export const TEST_DB_URL =
  process.env.AUDIENCE_TEST_DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/pocketlol_engagement_audience_test?schema=public";

export async function isDbConnected(prisma: any): Promise<boolean> {
  if (!prisma) return false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

export class FakeStorage implements AudienceFileStorage {
  objects = new Map<string, { body: Buffer; contentType: string }>();
  failPutOnCall: number | null = null;
  private putCalls = 0;

  async put(key: string, body: Buffer, contentType: string) {
    this.putCalls++;
    if (this.failPutOnCall === this.putCalls) throw new Error("simulated storage outage");
    this.objects.set(key, { body, contentType });
  }
  async remove(key: string) {
    this.objects.delete(key);
  }
  async signedReadUrl(key: string, ttl: number) {
    return `https://signed.example/${key}?ttl=${ttl}`;
  }
  publicUrl(key: string) {
    return `https://public.example/${key}`;
  }
}

export async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(globalResponsePlugin); // proves rawResponse opts out of the envelope
  await app.register(audienceRoutes, { prefix: "/client/audience" });
  await app.register(audienceAdminRoutes, { prefix: "/admin/audience" });
  await app.ready();
  return app;
}

// --- fixtures -------------------------------------------------------------

export async function jpegFixture(withExif = false): Promise<Buffer> {
  let img = sharp({ create: { width: 16, height: 16, channels: 3, background: "#c0392b" } });
  if (withExif) {
    img = img.withMetadata({ exif: { IFD0: { Copyright: "SECRET-GPS-OWNER" } } });
  }
  return img.jpeg().toBuffer();
}
export const pngFixture = () =>
  sharp({ create: { width: 8, height: 8, channels: 3, background: "#27ae60" } }).png().toBuffer();
export const webpFixture = () =>
  sharp({ create: { width: 8, height: 8, channels: 3, background: "#2980b9" } }).webp().toBuffer();
export const pdfFixture = () => Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");

// --- payload ---------------------------------------------------------------

export function person(i: number, overrides: Record<string, unknown> = {}) {
  return {
    full_name: `Person Number${i}`,
    age: 18 + (i % 60), // always within 1..99
    mobile: `9${String(100000000 + i).slice(-9)}`, // 9100000001.. always valid
    email: `Person${i}@Example.com`,
    ...overrides,
  };
}

/** A valid payload for a group of `size`, mobiles offset by `base` to keep groups disjoint. */
export function buildPayload(size = 5, base = 0, overrides: Record<string, unknown> = {}) {
  return {
    client_request_id: randomUUID(),
    lead: { ...person(base + 1), city: "Lucknow" },
    members: Array.from({ length: size - 1 }, (_, i) => ({
      position: i + 2,
      ...person(base + i + 2),
    })),
    photos_provided: [] as string[],
    group_pdf_provided: true,
    consent: { accepted: true, text_version: "v1", accepted_at: "2026-10-01T14:31:55+05:30" },
    device: { platform: "android", app_version: "1.4.0" },
    ...overrides,
  };
}

// --- multipart -------------------------------------------------------------

export interface MultipartFile {
  field: string;
  filename: string;
  contentType: string;
  data: Buffer;
}

export function multipartBody(payload: unknown, files: MultipartFile[] = [], extraFields: Record<string, string> = {}) {
  const boundary = `----audiencetest${randomUUID().replace(/-/g, "")}`;
  const chunks: Buffer[] = [];
  const text = (name: string, value: string) =>
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
      )
    );
  if (payload !== undefined) {
    text("payload", typeof payload === "string" ? payload : JSON.stringify(payload));
  }
  for (const [name, value] of Object.entries(extraFields)) text(name, value);
  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`
      ),
      file.data,
      Buffer.from("\r\n")
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

export async function submit(
  app: FastifyInstance,
  payload: unknown,
  files: MultipartFile[] = [],
  opts: { key?: string | null; userId?: string; userType?: string } = {}
) {
  const { body, contentType } = multipartBody(payload, files);
  const headers: Record<string, string> = { "content-type": contentType };
  if (opts.key !== null) headers["idempotency-key"] = opts.key ?? randomUUID();
  if (opts.userId) {
    headers["x-user-id"] = opts.userId;
    headers["x-user-type"] = opts.userType ?? "CUSTOMER";
  }
  const res = await app.inject({ method: "POST", url: "/client/audience/registration", headers, payload: body });
  return { status: res.statusCode, body: res.json() as any, raw: res };
}

export async function groupPdfFile(): Promise<MultipartFile> {
  return { field: "group_pdf", filename: "group.pdf", contentType: "application/pdf", data: pdfFixture() };
}
