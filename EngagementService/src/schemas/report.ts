import { z } from "zod";

export const submitReportBodySchema = z.object({
    reporter_name: z.string().trim().min(1).max(200),
    reporter_email: z.string().trim().email(),
    movie_show_name: z.string().trim().min(1).max(300),
    episode_name: z.string().trim().min(1).max(300).optional(),
    video_timestamp: z.string().trim().min(1).max(50),
    reason: z.string().trim().min(1).max(2000),
});

export const submitReportResponseSchema = z.object({
    ticket_id: z.string(),
});

export type SubmitReportBody = z.infer<typeof submitReportBodySchema>;
export type SubmitReportResponse = z.infer<typeof submitReportResponseSchema>;
