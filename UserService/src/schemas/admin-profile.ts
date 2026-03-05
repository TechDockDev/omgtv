import { z } from "zod";

export const updateAdminProfileSchema = z.object({
    name: z.string().trim().optional(),
    bio: z.string().trim().optional(),
    phoneNumber: z.string().trim().optional(),
    avatarUrl: z.string().trim().url().optional(),
});

export type UpdateAdminProfileBody = z.infer<typeof updateAdminProfileSchema>;
