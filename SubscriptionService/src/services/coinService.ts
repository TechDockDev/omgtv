import { getPrisma } from "../lib/prisma";
import { getRedis } from "../lib/redis";
import { CoinTransactionType, TransactionSource, WalletStatus } from "@prisma/client";

export class CoinService {
    private prisma = getPrisma();

    /**
     * Ensures a user has a wallet and returns it.
     */
    async getOrCreateWallet(userId: string, tx?: any) {
        const prisma = tx || this.prisma;
        return await prisma.userWallet.upsert({
            where: { userId },
            create: { userId, status: WalletStatus.ACTIVE },
            update: {} // No-op
        });
    }

    /**
     * Throws if the user's wallet is blocked.
     */
    async checkWalletStatus(userId: string, tx?: any) {
        const wallet = await this.getOrCreateWallet(userId, tx);
        if (wallet.status === WalletStatus.BLOCKED) {
            throw new Error("Wallet is blocked. Please contact support.");
        }
    }

    /**
     * Calculates the current spendable balance for a user.
     * Only includes unexpired Earned coins and all Purchased coins.
     */
    // get balance of user
    async getBalance(userId: string, tx?: any) {
        const prisma = tx || this.prisma;
        
        // 1. Check Redis Cache first (if not in a transaction)
        const redis = getRedis();
        const cacheKey = `coins:balance:${userId}`;
        if (!tx) {
            const cached = await redis.get(cacheKey).catch(() => null);
            if (cached !== null) return parseInt(cached);
        }

        const now = new Date();
        const credits = await prisma.coinTransaction.aggregate({
            where: {
                userId,
                type: CoinTransactionType.CREDIT,
                OR: [
                    { expiryAt: { gt: now } }, // Unexpired Earned coins
                    { expiryAt: null }         // Purchased coins (never expire)
                ]
            },
            _sum: { remainingAmount: true }
        });

        const balance = credits._sum.remainingAmount || 0;

        // 2. Cache the result for 60 seconds (if not in a transaction)
        if (!tx) {
            await redis.setex(cacheKey, 60, balance).catch(() => {});
        }

        return balance;
    }

    async invalidateBalanceCache(userId: string) {
        const redis = getRedis();
        await redis.del(`coins:balance:${userId}`).catch(() => {});
    }
    // credit coins to user
    async creditCoins(data: {
        userId: string;
        amount: number;
        source: TransactionSource;
        referenceId?: string;
        expiryDays?: number;
    }, tx?: any) {
        const prisma = tx || this.prisma;
        
        // Ensure wallet is not blocked before crediting
        await this.checkWalletStatus(data.userId, prisma);

        const expiryAt = data.expiryDays
            ? new Date(Date.now() + data.expiryDays * 24 * 60 * 60 * 1000)
            : null;

        if (data.referenceId) {
            // Idempotent upsert by referenceId
            const res = await prisma.coinTransaction.upsert({
                where: { referenceId: data.referenceId },
                update: {}, // No-op if already exists
                create: {
                    userId: data.userId,
                    type: CoinTransactionType.CREDIT,
                    source: data.source,
                    amount: data.amount,
                    remainingAmount: data.amount,
                    referenceId: data.referenceId,
                    expiryAt
                }
            });
        
        await this.invalidateBalanceCache(data.userId);
        return res;
    }

    return await prisma.coinTransaction.create({
        data: {
            userId: data.userId,
            type: CoinTransactionType.CREDIT,
            source: data.source,
            amount: data.amount,
            remainingAmount: data.amount,
            referenceId: data.referenceId,
            expiryAt
        }
    }).then(async (res: any) => {
        await this.invalidateBalanceCache(data.userId);
        return res;
    });
}
    // debit coins from user
    async debitCoins(userId: string, amount: number, referenceId: string) {
        return await this.prisma.$transaction(async (tx) => {
            // Check wallet status inside the transaction
            await this.checkWalletStatus(userId, tx);

            // 0. Check for existing DEBIT with SAME referenceId (Idempotency)
            if (referenceId) {
                const existing = await tx.coinTransaction.findUnique({
                    where: { referenceId }
                });
                if (existing) return existing;
            }

            // 1. Check total balance first (inside transaction for consistency)
            const currentBalance = await this.getBalance(userId, tx);
            if (currentBalance < amount) {
                throw new Error("Insufficient coin balance");
            }

            // 2. Fetch all spendable credits, sorted by expiry (Earned first, then Purchased)
            // Use tx.coinTransaction.findMany to ensure we use the transaction client
            const availableCredits = await tx.coinTransaction.findMany({
                where: {
                    userId,
                    type: CoinTransactionType.CREDIT,
                    remainingAmount: { gt: 0 },
                    OR: [
                        { expiryAt: { gt: new Date() } },
                        { expiryAt: null }
                    ]
                },
                orderBy: [
                    { expiryAt: 'asc' }, // Soonest expiry first (Earned)
                    { createdAt: 'asc' } // Then by date for purchased/same-expiry
                ]
            });

            let remainingToDebit = amount;

            // 3. Drain credits one by one
            for (const credit of availableCredits) {
                if (remainingToDebit <= 0) break;

                const amountToTake = Math.min(credit.remainingAmount!, remainingToDebit);

                await tx.coinTransaction.update({
                    where: { id: credit.id },
                    data: { remainingAmount: { decrement: amountToTake } }
                });

                remainingToDebit -= amountToTake;
            }

            // Guard against concurrent debit race condition (READ COMMITTED allows
            // two transactions to both pass the balance check above, then compete
            // for the same credits — this catches the loser and rolls back cleanly)
            if (remainingToDebit > 0) {
                throw new Error("Insufficient coin balance");
            }

            // 4. Record the final DEBIT transaction for auditing
            const debit = await tx.coinTransaction.create({
                data: {
                    userId,
                    type: CoinTransactionType.DEBIT,
                    source: TransactionSource.UNLOCK,
                    amount: -amount,
                    referenceId,
                    metadata: { originalAmount: amount }
                }
            });

            await this.invalidateBalanceCache(userId);
            return debit;
        });
    }

    // unlcok episodes
    /**
 * Unlocks an episode for a user permanently.
 * Checks for existing unlock before debiting balance.
 */
    async unlockEpisode(userId: string, episodeId: string, cost: number) {
        // 1. Check if already unlocked
        const existing = await this.prisma.userEpisodeUnlock.findUnique({
            where: { userId_episodeId: { userId, episodeId } }
        });

        if (existing) {
            return { status: "ALREADY_UNLOCKED", unlock: existing };
        }

        // 2. Use a deterministic referenceId (no Date.now()) so concurrent
        //    requests with the same episodeId share one idempotency key.
        //    debitCoins will return the existing DEBIT record on the second call.
        const referenceId = `unlock:${userId}:${episodeId}`;
        await this.debitCoins(userId, cost, referenceId);

        // 3. Record permanent unlock — handle the race where two concurrent
        //    requests both passed the findUnique check above.
        try {
            const unlock = await this.prisma.userEpisodeUnlock.create({
                data: { userId, episodeId }
            });
            return { status: "SUCCESS", unlock };
        } catch (err: any) {
            // P2002 = unique constraint violation (concurrent duplicate unlock)
            if (err?.code === "P2002") {
                const unlock = await this.prisma.userEpisodeUnlock.findUnique({
                    where: { userId_episodeId: { userId, episodeId } }
                });
                return { status: "ALREADY_UNLOCKED", unlock };
            }
            throw err;
        }
    }

    /**
     * Fetches unified transaction history for a user.
     */
    async getTransactions(userId: string, limit = 20, offset = 0) {
        return await this.prisma.coinTransaction.findMany({
            where: { userId },
            orderBy: { createdAt: "desc" },
            take: limit,
            skip: offset
        });
    }
}
