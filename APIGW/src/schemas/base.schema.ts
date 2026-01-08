import { z } from "zod";
import type {
  ErrorResponse,
  ErrorStatusCode,
  SuccessResponse,
} from "../utils/envelope";

const errorStatusCodeSchema = z.number().int().min(400).max(599);

export function createSuccessResponseSchema<T extends z.ZodTypeAny>(
  dataSchema: T
) {
  return z
    .object({
      success: z.literal(true),
      statusCode: z.literal(0),
      userMessage: z.string(),
      developerMessage: z.string(),
      data: dataSchema,
    })
    .strict() as z.ZodType<SuccessResponse<z.infer<T>>>;
}

export const errorResponseSchema = z
  .object({
    success: z.literal(false),
    statusCode: errorStatusCodeSchema,
    userMessage: z.string(),
    developerMessage: z.string(),
    data: z.object({}).strict(),
  })
  .strict() as z.ZodType<ErrorResponse>;

export type ErrorStatusCodeSchema = z.infer<typeof errorStatusCodeSchema>;
