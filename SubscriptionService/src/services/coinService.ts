import { getPrisma } from "../lib/prisma";
import { CoinTransactionType, TransactionSource } from "@prisma/client";

export class CoinService {
    private prisma = getPrisma();

    /**
     * Calculates the current spendable balance for a user.
     * Only includes unexpired Earned coins and all Purchased coins.
     */
    // get balance of user
    async getBalance(userId: string) {
        const now = new Date();

        const credits = await this.prisma.coinTransaction.aggregate({
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

        return credits._sum.remainingAmount || 0;
    }
    // credit coins to user
    async creditCoins(data: {
        userId: string;
        amount: number;
        source: TransactionSource;
        referenceId?: string;
        expiryDays?: number;
    }) {
        const expiryAt = data.expiryDays
            ? new Date(Date.now() + data.expiryDays * 24 * 60 * 60 * 1000)
            : null;

        return await this.prisma.coinTransaction.create({
            data: {
                userId: data.userId,
                type: CoinTransactionType.CREDIT,
                source: data.source,
                amount: data.amount,
                remainingAmount: data.amount, // Track spendable balance
                referenceId: data.referenceId,
                expiryAt
            }
        });
    }
    // debit coins from user
    async debitCoins(userId: string, amount: number, referenceId: string) {
        return await this.prisma.$transaction(async (tx) => {
            // 1. Check total balance first
            const currentBalance = await this.getBalance(userId);
            if (currentBalance < amount) {
                throw new Error("Insufficient coin balance");
            }

            // 2. Fetch all spendable credits, sorted by expiry (Earned first, then Purchased)
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

            // 4. Record the final DEBIT transaction for auditing
            return await tx.coinTransaction.create({
                data: {
                    userId,
                    type: CoinTransactionType.DEBIT,
                    source: TransactionSource.UNLOCK,
                    amount: -amount,
                    referenceId,
                    metadata: { originalAmount: amount }
                }
            });
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

        // 2. Perform debit (this uses the Priority Algorithm)
        const referenceId = `unlock:${userId}:${episodeId}:${Date.now()}`;
        await this.debitCoins(userId, cost, referenceId);

        // 3. Record permanent unlock
        const unlock = await this.prisma.userEpisodeUnlock.create({
            data: { userId, episodeId }
        });

        return { status: "SUCCESS", unlock };
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
