import type { FastifyInstance } from "fastify";
import { z } from "zod";

const CONFIG_KEYS = ["video_button_text", "audio_button_text"] as const;

const DEFAULT_VALUES: Record<string, string> = {
  video_button_text: "VIDEO",
  audio_button_text: "AUDIO",
};

const updateSchema = z.object({
  video_button_text: z.string().min(1).max(100).optional(),
  audio_button_text: z.string().min(1).max(100).optional(),
});

export async function getAppConfig(prisma: any): Promise<Record<string, string>> {
  const rows = await prisma.appConfig.findMany({ where: { key: { in: [...CONFIG_KEYS] } } });
  const result = { ...DEFAULT_VALUES };
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

export default async function adminAppConfigRoutes(app: FastifyInstance) {
  // GET /admin/app-config — read current values
  app.get("/", async () => {
    const config = await getAppConfig(app.prisma);
    return { success: true, data: config };
  });

  // PUT /admin/app-config — update one or both values
  app.put("/", {
    schema: { body: updateSchema },
  }, async (request) => {
    const body = updateSchema.parse(request.body);
    const updates = Object.entries(body).filter(([, v]) => v !== undefined) as [string, string][];

    if (updates.length === 0) {
      return { success: true, data: await getAppConfig(app.prisma) };
    }

    await Promise.all(
      updates.map(([key, value]) =>
        app.prisma.appConfig.upsert({
          where: { key },
          update: { value },
          create: { key, value },
        })
      )
    );

    return { success: true, data: await getAppConfig(app.prisma) };
  });
}
