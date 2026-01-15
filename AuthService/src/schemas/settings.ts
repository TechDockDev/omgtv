import { z } from "zod";

export const generalSettingSchema = z.object({
    supportEmail: z.string().email().optional().or(z.literal("")),
    helpCenterEmail: z.string().email().optional().or(z.literal("")),
    contactPhone: z.string().optional(),
    whatsappNumber: z.string().optional(),
    twitterHandle: z.string().optional(),
    facebookUrl: z.string().url().optional().or(z.literal("")),
    instagramHandle: z.string().optional(),
    companyName: z.string().optional(),
    businessAddress: z.string().optional(),
    updatedByAdminId: z.string().optional(),
});

export const generalSettingResponseSchema = z.object({
    success: z.boolean(),
    statusCode: z.number(),
    userMessage: z.string(),
    developerMessage: z.string().optional(),
    data: generalSettingSchema.extend({
        id: z.number(),
        createdAt: z.date(),
        updatedAt: z.date(),
    }).nullable(),
});

export type GeneralSettingBody = z.infer<typeof generalSettingSchema>;
