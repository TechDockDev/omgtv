import { PrismaClient } from "@prisma/client";

const HISTORY_RETENTION_LIMIT = 50;

export async function addSearchHistory({
    prisma,
    userId,
    query,
}: {
    prisma: PrismaClient;
    userId: string;
    query: string;
}) {
    // Normalize query
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return;

    // Transaction: Create implementation and clean up old
    await prisma.$transaction(async (tx) => {
        // 1. Create new entry
        await tx.searchHistory.create({
            data: {
                userId,
                query: normalizedQuery,
            },
        });

        // 2. Cleanup: Count entries
        // Optimization: Only cleanup if count > limit + buffer (e.g. 10) to avoid counting on every search
        // But for strict limits, we can do delete where not in top N

        // Efficient Retention:
        // Delete all records for this user that are NOT in the top N sorted by createdAt DESC
        // This is hard to do in one "deleteMany" without subquery support which Prisma has limitations on.
        // Alternative: fetch the Nth ID and delete older than that.

        const recent = await tx.searchHistory.findMany({
            where: { userId },
            orderBy: { createdAt: "desc" },
            take: HISTORY_RETENTION_LIMIT,
            select: { id: true },
        });

        if (recent.length === HISTORY_RETENTION_LIMIT) {
            const oldestKeptId = recent[recent.length - 1].id;
            // Delete anything older than the oldest kept, OR not in the list of kept IDs
            // using "NOT IN" is safer
            const keepIds = recent.map(r => r.id);
            await tx.searchHistory.deleteMany({
                where: {
                    userId,
                    id: { notIn: keepIds },
                },
            });
        }
    });

    return { success: true };
}

export async function getSearchHistory({
    prisma,
    userId,
    limit = 20,
}: {
    prisma: PrismaClient;
    userId: string;
    limit?: number;
}) {
    const history = await prisma.searchHistory.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: limit,
        distinct: ["query"], // distinct on query to show unique terms? 
        // Prisma "distinct" returns the first occurrence. If we want "latest unique searches", 
        // simply ordering by createdAt desc valid?
        // If a user searched "foo" yesterday and "foo" today, do we want to show "foo" twice?
        // Usually we dedupe. But distinct with orderBy createdAt might be tricky in some DBs.
        // Let's rely on app-side deduping or just standard list for now.
        // If we want unique strings, we might need to group by query. 
        // Let's simpler: fetch raw, then dedupe in code. 
    });

    // Dedupe logic: Keep the latest (by create time, which is effectively preservation of order if we iterate)
    // History is already ordered by createdAt desc.
    // So the first time we see a query, it is the latest.
    const seen = new Set<string>();
    const dedupedRaw = [];
    for (const h of history) {
        if (!seen.has(h.query)) {
            seen.add(h.query);
            dedupedRaw.push({
                id: h.id,
                query: h.query,
                createdAt: h.createdAt,
            });
        }
    }

    return dedupedRaw;
}
