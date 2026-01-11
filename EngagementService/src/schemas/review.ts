import { z } from "zod";

export const reviewSchema = z.object({
    review_id: z.string().uuid(),
    user_id: z.string().uuid(),
    user_name: z.string().min(1),
    rating: z.number().int().min(1).max(5),
    title: z.string().min(1).max(100),
    comment: z.string().min(1).max(2000),
    created_at: z.string().datetime(),
});

export const addReviewBodySchema = z.object({
    user_name: z.string().min(1),
    rating: z.number().int().min(1).max(5),
    title: z.string().min(1).max(100),
    comment: z.string().min(1).max(2000),
});

export const getReviewsQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    cursor: z.string().optional(),
});

export const reviewSummarySchema = z.object({
    average_rating: z.number().min(0).max(5),
    total_reviews: z.number().int().nonnegative(),
});

export const reviewsResponseSchema = z.object({
    summary: reviewSummarySchema,
    user_reviews: z.array(reviewSchema),
    next_cursor: z.string().nullable(),
});

export type Review = z.infer<typeof reviewSchema>;
export type ReviewSummary = z.infer<typeof reviewSummarySchema>;
export type ReviewsResponse = z.infer<typeof reviewsResponseSchema>;
