import { getPrisma } from "../lib/prisma";
import { TransactionSource, StreakStatus } from "@prisma/client";
import { CoinService } from "./coinService";

const TOTAL_DAYS = 30;
const MIN_HOURS_BETWEEN_CLAIMS = 24;
const BREAK_AFTER_HOURS = 48;

const coinService = new CoinService();

export class StreakService {
    private prisma = getPrisma();

    async getOrCreateConfig() {
        return this.prisma.streakConfig.upsert({
            where: { id: 1 },
            create: { id: 1, isEnabled: true, coinsPerDay: 10, version: 1 },
            update: {},
        });
    }

    async getMilestonesForVersion(configVersion: number) {
        return this.prisma.streakMilestone.findMany({
            where: { configVersion, isEnabled: true },
            orderBy: { dayNumber: "asc" },
        });
    }

    // ── Customer ───────────────────────────────────────────────────────────────

    async getStatus(userId: string) {
        const config = await this.getOrCreateConfig();

        const userStreak = await this.prisma.userStreak.findUnique({ where: { userId } });
        const milestones = await this.getMilestonesForVersion(
            userStreak?.configVersion ?? config.version
        );

        const now = new Date();
        let canClaimNow = false;
        let nextClaimAt: Date | null = null;
        let streakExpiresAt: Date | null = null;
        let currentDay = 1;
        let cyclesCompleted = 0;
        let status: StreakStatus = StreakStatus.ACTIVE;
        let claimedDays: number[] = [];

        if (userStreak) {
            currentDay = userStreak.currentDay;
            cyclesCompleted = userStreak.cyclesCompleted;
            status = userStreak.status;

            if (userStreak.lastClaimedAt) {
                const hoursSinceLast =
                    (now.getTime() - userStreak.lastClaimedAt.getTime()) / (1000 * 60 * 60);

                if (hoursSinceLast > BREAK_AFTER_HOURS) {
                    status = StreakStatus.BROKEN;
                    canClaimNow = true; // will reset + claim day 1
                } else if (hoursSinceLast >= MIN_HOURS_BETWEEN_CLAIMS) {
                    canClaimNow = true;
                    streakExpiresAt = new Date(
                        userStreak.lastClaimedAt.getTime() + BREAK_AFTER_HOURS * 60 * 60 * 1000
                    );
                } else {
                    canClaimNow = false;
                    nextClaimAt = new Date(
                        userStreak.lastClaimedAt.getTime() + MIN_HOURS_BETWEEN_CLAIMS * 60 * 60 * 1000
                    );
                    streakExpiresAt = new Date(
                        userStreak.lastClaimedAt.getTime() + BREAK_AFTER_HOURS * 60 * 60 * 1000
                    );
                }
            } else {
                canClaimNow = true;
            }

            // fetch claimed days only if streak is active — filter by cycleStartedAt so a
            // break+reset within the same cycleNumber doesn't bleed old claims into the new grid
            if (status !== StreakStatus.BROKEN) {
                const logs = await this.prisma.streakClaimLog.findMany({
                    where: {
                        userId,
                        claimedAt: { gte: userStreak.cycleStartedAt },
                    },
                    select: { dayNumber: true },
                });
                claimedDays = logs.map((l: { dayNumber: number }) => l.dayNumber);
            }
        } else {
            canClaimNow = true;
        }

        const milestoneMap = new Map(milestones.map((m) => [m.dayNumber, m]));
        const effectiveCurrentDay = status === StreakStatus.BROKEN ? 1 : currentDay;

        const days = Array.from({ length: TOTAL_DAYS }, (_, i) => {
            const day = i + 1;
            const milestone = milestoneMap.get(day);
            const isClaimed = claimedDays.includes(day);
            const isToday = !isClaimed && day === effectiveCurrentDay && config.isEnabled;

            return {
                dayNumber: day,
                coinsEarned: config.coinsPerDay,
                isMilestone: !!milestone,
                bonusCoins: milestone?.bonusCoins ?? 0,
                bonusExpiryHours: milestone?.bonusExpiryHours ?? null,
                status: isClaimed ? "CLAIMED" : isToday ? "CLAIMABLE" : "LOCKED",
            };
        });

        return {
            isEnabled: config.isEnabled,
            currentDay: effectiveCurrentDay,
            cyclesCompleted,
            status,
            canClaimNow: config.isEnabled ? canClaimNow : false,
            nextClaimAt,
            streakExpiresAt,
            coinsPerDay: config.coinsPerDay,
            coinExpiryHours: config.coinExpiryHours,
            milestones: milestones.map((m) => ({
                dayNumber: m.dayNumber,
                bonusCoins: m.bonusCoins,
                bonusExpiryHours: m.bonusExpiryHours,
                isReached: claimedDays.includes(m.dayNumber),
            })),
            days,
        };
    }

    async claim(userId: string) {
        const config = await this.getOrCreateConfig();
        if (!config.isEnabled) {
            const err: any = new Error("Streak feature is currently disabled");
            err.code = "STREAK_DISABLED";
            throw err;
        }

        await coinService.checkWalletStatus(userId);

        const now = new Date();

        const result = await this.prisma.$transaction(async (tx) => {
            let userStreak = await tx.userStreak.findUnique({ where: { userId } });

            if (!userStreak) {
                userStreak = await tx.userStreak.create({
                    data: {
                        userId,
                        currentDay: 1,
                        cyclesCompleted: 0,
                        cycleStartedAt: now,
                        configVersion: config.version,
                        status: StreakStatus.ACTIVE,
                    },
                });
            } else if (userStreak.lastClaimedAt) {
                const hoursSinceLast =
                    (now.getTime() - userStreak.lastClaimedAt.getTime()) / (1000 * 60 * 60);

                if (hoursSinceLast < MIN_HOURS_BETWEEN_CLAIMS) {
                    const err: any = new Error("Already claimed today");
                    err.code = "ALREADY_CLAIMED_TODAY";
                    throw err;
                }

                if (hoursSinceLast > BREAK_AFTER_HOURS) {
                    // Record break day before reset
                    userStreak = await tx.userStreak.update({
                        where: { userId },
                        data: {
                            currentDay: 1,
                            lastClaimedAt: null,
                            cycleStartedAt: now,
                            configVersion: config.version,
                            status: StreakStatus.ACTIVE,
                            lastBrokeAtDay: userStreak.currentDay,
                        },
                    });
                }
            }

            const dayNumber = userStreak.currentDay;
            const cycleNumber = userStreak.cyclesCompleted + 1;

            const milestone = await tx.streakMilestone.findFirst({
                where: {
                    configVersion: userStreak.configVersion,
                    dayNumber,
                    isEnabled: true,
                },
            });

            // Credit daily coins
            const coinExpiryDays = config.coinExpiryHours
                ? config.coinExpiryHours / 24
                : undefined;
            await coinService.creditCoins(
                {
                    userId,
                    amount: config.coinsPerDay,
                    source: TransactionSource.STREAK,
                    referenceId: `streak:${userId}:${userStreak.cycleStartedAt.getTime()}:d${dayNumber}`,
                    expiryDays: coinExpiryDays,
                },
                tx
            );

            // Credit milestone bonus
            let bonusEarned = 0;
            let bonusExpiryAt: Date | null = null;
            if (milestone) {
                const bonusExpiryDays = milestone.bonusExpiryHours
                    ? milestone.bonusExpiryHours / 24
                    : undefined;
                await coinService.creditCoins(
                    {
                        userId,
                        amount: milestone.bonusCoins,
                        source: TransactionSource.STREAK_BONUS,
                        referenceId: `streak_bonus:${userId}:${userStreak.cycleStartedAt.getTime()}:d${dayNumber}`,
                        expiryDays: bonusExpiryDays,
                    },
                    tx
                );
                bonusEarned = milestone.bonusCoins;
                if (milestone.bonusExpiryHours) {
                    bonusExpiryAt = new Date(
                        now.getTime() + milestone.bonusExpiryHours * 60 * 60 * 1000
                    );
                }
            }

            const isLastDay = dayNumber === TOTAL_DAYS;
            const nextDay = isLastDay ? 1 : dayNumber + 1;
            const newCyclesCompleted = isLastDay
                ? userStreak.cyclesCompleted + 1
                : userStreak.cyclesCompleted;
            const newCycleStartedAt = isLastDay ? now : userStreak.cycleStartedAt;

            await tx.userStreak.update({
                where: { userId },
                data: {
                    currentDay: nextDay,
                    lastClaimedAt: now,
                    cyclesCompleted: newCyclesCompleted,
                    cycleStartedAt: newCycleStartedAt,
                    status: StreakStatus.ACTIVE,
                    lastBrokeAtDay: null,
                    streakReminderSentAt: null, // reset so next cycle reminder fires again
                },
            });

            await tx.streakClaimLog.create({
                data: {
                    userId,
                    dayNumber,
                    coinsEarned: config.coinsPerDay,
                    bonusEarned,
                    milestoneId: milestone?.id ?? null,
                    cycleNumber,
                    configVersion: userStreak.configVersion,
                },
            });

            return {
                dayNumber,
                coinsEarned: config.coinsPerDay,
                bonusEarned,
                bonusExpiryAt,
                cycleCompleted: isLastDay,
                newBalance: 0, // filled after tx
                nextClaimAt: new Date(now.getTime() + MIN_HOURS_BETWEEN_CLAIMS * 60 * 60 * 1000),
                streakExpiresAt: new Date(now.getTime() + BREAK_AFTER_HOURS * 60 * 60 * 1000),
            };
        });

        await coinService.invalidateBalanceCache(userId);
        result.newBalance = await coinService.getBalance(userId);
        return result;
    }

    async getHistory(userId: string, page: number, limit: number) {
        const skip = (page - 1) * limit;
        const [total, logs] = await Promise.all([
            this.prisma.streakClaimLog.count({ where: { userId } }),
            this.prisma.streakClaimLog.findMany({
                where: { userId },
                orderBy: { claimedAt: "desc" },
                skip,
                take: limit,
            }),
        ]);
        return { total, page, limit, logs };
    }

    // ── Admin ──────────────────────────────────────────────────────────────────

    async updateConfig(
        data: { isEnabled?: boolean; coinsPerDay?: number; coinExpiryHours?: number | null },
        adminId: string
    ) {
        const current = await this.getOrCreateConfig();
        const newVersion = current.version + 1;

        // Copy existing milestones to new version before bumping
        const existingMilestones = await this.prisma.streakMilestone.findMany({
            where: { configVersion: current.version },
        });

        await this.prisma.$transaction(async (tx) => {
            await tx.streakConfig.update({
                where: { id: 1 },
                data: { ...data, version: newVersion, updatedByAdminId: adminId },
            });
            if (existingMilestones.length > 0) {
                await tx.streakMilestone.createMany({
                    data: existingMilestones.map((m) => ({
                        configVersion: newVersion,
                        dayNumber: m.dayNumber,
                        bonusCoins: m.bonusCoins,
                        bonusExpiryHours: m.bonusExpiryHours,
                        isEnabled: m.isEnabled,
                    })),
                    skipDuplicates: true,
                });
            }
        });

        return this.prisma.streakConfig.findUnique({ where: { id: 1 } });
    }

    async createMilestone(data: {
        dayNumber: number;
        bonusCoins: number;
        bonusExpiryHours?: number | null;
    }) {
        const config = await this.getOrCreateConfig();
        if (data.dayNumber < 1 || data.dayNumber > TOTAL_DAYS) {
            const err: any = new Error(`dayNumber must be between 1 and ${TOTAL_DAYS}`);
            err.code = "INVALID_DAY";
            throw err;
        }
        // Creating a milestone bumps config version so existing user streaks stay on old snapshot
        const newVersion = config.version + 1;
        const [existing] = await this.prisma.$transaction([
            this.prisma.streakMilestone.upsert({
                where: { configVersion_dayNumber: { configVersion: newVersion, dayNumber: data.dayNumber } },
                create: { configVersion: newVersion, ...data },
                update: { bonusCoins: data.bonusCoins, bonusExpiryHours: data.bonusExpiryHours ?? null, isEnabled: true },
            }),
            this.prisma.streakConfig.update({
                where: { id: 1 },
                data: { version: newVersion },
            }),
        ]);

        // Copy all other milestones from old version to new version
        const oldMilestones = await this.prisma.streakMilestone.findMany({
            where: { configVersion: config.version, dayNumber: { not: data.dayNumber } },
        });
        if (oldMilestones.length > 0) {
            await this.prisma.streakMilestone.createMany({
                data: oldMilestones.map((m) => ({
                    configVersion: newVersion,
                    dayNumber: m.dayNumber,
                    bonusCoins: m.bonusCoins,
                    bonusExpiryHours: m.bonusExpiryHours,
                    isEnabled: m.isEnabled,
                })),
                skipDuplicates: true,
            });
        }

        return existing;
    }

    async updateMilestone(
        id: string,
        data: { bonusCoins?: number; bonusExpiryHours?: number | null; isEnabled?: boolean; dayNumber?: number }
    ) {
        const milestone = await this.prisma.streakMilestone.findUnique({ where: { id } });
        if (!milestone) {
            const err: any = new Error("Milestone not found");
            err.code = "NOT_FOUND";
            throw err;
        }
        const config = await this.getOrCreateConfig();
        const newVersion = config.version + 1;

        // Copy all milestones to new version with the updated one changed
        const allMilestones = await this.prisma.streakMilestone.findMany({
            where: { configVersion: config.version },
        });

        // match by dayNumber — ids change on every version copy
        const newMilestones = allMilestones.map((m) => {
            if (m.dayNumber === milestone.dayNumber) {
                return {
                    configVersion: newVersion,
                    dayNumber: data.dayNumber ?? m.dayNumber,
                    bonusCoins: data.bonusCoins ?? m.bonusCoins,
                    bonusExpiryHours: data.bonusExpiryHours !== undefined ? data.bonusExpiryHours : m.bonusExpiryHours,
                    isEnabled: data.isEnabled !== undefined ? data.isEnabled : m.isEnabled,
                };
            }
            return {
                configVersion: newVersion,
                dayNumber: m.dayNumber,
                bonusCoins: m.bonusCoins,
                bonusExpiryHours: m.bonusExpiryHours,
                isEnabled: m.isEnabled,
            };
        });

        await this.prisma.$transaction([
            this.prisma.streakConfig.update({ where: { id: 1 }, data: { version: newVersion } }),
            this.prisma.streakMilestone.createMany({ data: newMilestones, skipDuplicates: true }),
        ]);

        return this.prisma.streakMilestone.findFirst({
            where: { configVersion: newVersion, dayNumber: data.dayNumber ?? milestone.dayNumber },
        });
    }

    async deleteMilestone(id: string) {
        const milestone = await this.prisma.streakMilestone.findUnique({ where: { id } });
        if (!milestone) {
            const err: any = new Error("Milestone not found");
            err.code = "NOT_FOUND";
            throw err;
        }
        const config = await this.getOrCreateConfig();
        const newVersion = config.version + 1;

        // exclude by dayNumber — ids change on every version copy
        const remaining = await this.prisma.streakMilestone.findMany({
            where: { configVersion: config.version, dayNumber: { not: milestone.dayNumber } },
        });

        await this.prisma.$transaction([
            this.prisma.streakConfig.update({ where: { id: 1 }, data: { version: newVersion } }),
            ...(remaining.length > 0
                ? [
                    this.prisma.streakMilestone.createMany({
                        data: remaining.map((m) => ({
                            configVersion: newVersion,
                            dayNumber: m.dayNumber,
                            bonusCoins: m.bonusCoins,
                            bonusExpiryHours: m.bonusExpiryHours,
                            isEnabled: m.isEnabled,
                        })),
                        skipDuplicates: true,
                    }),
                ]
                : []),
        ]);
    }

    async resetAllStreaks() {
        const config = await this.getOrCreateConfig();
        const { count } = await this.prisma.userStreak.updateMany({
            data: {
                currentDay: 1,
                lastClaimedAt: null,
                status: StreakStatus.ACTIVE,
                configVersion: config.version,
                lastBrokeAtDay: null,
            },
        });
        return count;
    }

    // Returns a Prisma `where` clause that correctly identifies broken streaks using
    // timestamp math — BROKEN is never written to the DB, so status field can't be used.
    private brokenWhere() {
        const cutoff = new Date(Date.now() - BREAK_AFTER_HOURS * 60 * 60 * 1000);
        return { lastClaimedAt: { lt: cutoff, not: null } };
    }

    private activeWhere() {
        const cutoff = new Date(Date.now() - BREAK_AFTER_HOURS * 60 * 60 * 1000);
        return {
            OR: [
                { lastClaimedAt: null },
                { lastClaimedAt: { gte: cutoff } },
            ],
        };
    }

    async getAnalytics() {
        const config = await this.getOrCreateConfig();
        const milestones = await this.getMilestonesForVersion(config.version);

        const [
            totalActive,
            totalBroken,
            cyclesCompletedSum,
            dayDistributionRaw,
            breakDistributionRaw,
            coinsFromStreak,
            coinsFromBonus,
        ] = await Promise.all([
            this.prisma.userStreak.count({ where: this.activeWhere() }),
            this.prisma.userStreak.count({ where: this.brokenWhere() }),
            this.prisma.userStreak.aggregate({ _sum: { cyclesCompleted: true } }),
            this.prisma.userStreak.groupBy({
                by: ["currentDay"],
                where: this.activeWhere(),
                _count: { userId: true },
                orderBy: { currentDay: "asc" },
            }),
            this.prisma.userStreak.groupBy({
                by: ["lastBrokeAtDay"],
                where: { lastBrokeAtDay: { not: null } },
                _count: { userId: true },
                orderBy: { lastBrokeAtDay: "asc" },
            }),
            this.prisma.coinTransaction.aggregate({
                where: { source: TransactionSource.STREAK },
                _sum: { amount: true },
            }),
            this.prisma.coinTransaction.aggregate({
                where: { source: TransactionSource.STREAK_BONUS },
                _sum: { amount: true },
            }),
        ]);

        // Milestone funnel: how many unique users have a StreakClaimLog at each milestone day
        const milestoneFunnel = await Promise.all(
            milestones.map(async (m) => {
                const reached = await this.prisma.streakClaimLog.groupBy({
                    by: ["userId"],
                    where: { dayNumber: m.dayNumber, milestoneId: m.id },
                });
                return {
                    dayNumber: m.dayNumber,
                    bonusCoins: m.bonusCoins,
                    reached: reached.length,
                };
            })
        );

        const currentDayDistribution = Array.from({ length: TOTAL_DAYS }, (_, i) => {
            const day = i + 1;
            const found = dayDistributionRaw.find((d) => d.currentDay === day);
            return { day, userCount: found?._count.userId ?? 0 };
        });

        const breakDayDistribution = breakDistributionRaw
            .filter((b) => b.lastBrokeAtDay !== null)
            .map((b) => ({ day: b.lastBrokeAtDay!, breaks: b._count.userId }));

        return {
            totalActiveStreaks: totalActive,
            totalBrokenStreaks: totalBroken,
            cyclesCompletedAllTime: cyclesCompletedSum._sum.cyclesCompleted ?? 0,
            currentDayDistribution,
            breakDayDistribution,
            milestoneFunnel,
            coinsDistributed: {
                fromStreak: coinsFromStreak._sum.amount ?? 0,
                fromBonuses: coinsFromBonus._sum.amount ?? 0,
            },
        };
    }

    async getUserStreaks(
        page: number,
        limit: number,
        filters: { status?: StreakStatus; currentDay?: number; cyclesCompleted?: number }
    ) {
        const where: any = {};
        if (filters.status === StreakStatus.BROKEN) Object.assign(where, this.brokenWhere());
        else if (filters.status === StreakStatus.ACTIVE) Object.assign(where, this.activeWhere());
        if (filters.currentDay) where.currentDay = filters.currentDay;
        if (filters.cyclesCompleted !== undefined) where.cyclesCompleted = filters.cyclesCompleted;

        const skip = (page - 1) * limit;
        const [total, streaks] = await Promise.all([
            this.prisma.userStreak.count({ where }),
            this.prisma.userStreak.findMany({
                where,
                orderBy: { updatedAt: "desc" },
                skip,
                take: limit,
            }),
        ]);

        const now = Date.now();
        const enriched = await Promise.all(
            streaks.map(async (s) => {
                const [totalCoins, totalBonus] = await Promise.all([
                    this.prisma.coinTransaction.aggregate({
                        where: { userId: s.userId, source: TransactionSource.STREAK },
                        _sum: { amount: true },
                    }),
                    this.prisma.coinTransaction.aggregate({
                        where: { userId: s.userId, source: TransactionSource.STREAK_BONUS },
                        _sum: { amount: true },
                    }),
                ]);
                const streakExpiresAt = s.lastClaimedAt
                    ? new Date(s.lastClaimedAt.getTime() + BREAK_AFTER_HOURS * 60 * 60 * 1000)
                    : null;
                const isBroken = s.lastClaimedAt !== null &&
                    (now - s.lastClaimedAt.getTime()) > BREAK_AFTER_HOURS * 60 * 60 * 1000;
                return {
                    userId: s.userId,
                    currentDay: s.currentDay,
                    status: isBroken ? StreakStatus.BROKEN : StreakStatus.ACTIVE,
                    cyclesCompleted: s.cyclesCompleted,
                    lastClaimedAt: s.lastClaimedAt,
                    streakExpiresAt,
                    totalCoinsEarned: totalCoins._sum.amount ?? 0,
                    totalBonusEarned: totalBonus._sum.amount ?? 0,
                };
            })
        );

        return { total, page, limit, streaks: enriched };
    }

    async getUserStreakDetail(userId: string) {
        const userStreak = await this.prisma.userStreak.findUnique({ where: { userId } });

        const logs = await this.prisma.streakClaimLog.findMany({
            where: { userId },
            orderBy: [{ cycleNumber: "asc" }, { dayNumber: "asc" }],
        });

        // Group by cycle
        const cycleMap = new Map<number, typeof logs>();
        for (const log of logs) {
            if (!cycleMap.has(log.cycleNumber)) cycleMap.set(log.cycleNumber, []);
            cycleMap.get(log.cycleNumber)!.push(log);
        }

        const cycles = Array.from(cycleMap.entries()).map(([cycleNumber, claims]) => ({
            cycleNumber,
            startedAt: claims[0].claimedAt,
            completedAt: claims.length === TOTAL_DAYS ? claims[claims.length - 1].claimedAt : null,
            claimsCount: claims.length,
            claims,
        }));

        const streakExpiresAt =
            userStreak?.lastClaimedAt
                ? new Date(userStreak.lastClaimedAt.getTime() + BREAK_AFTER_HOURS * 60 * 60 * 1000)
                : null;

        const isBroken = userStreak?.lastClaimedAt
            ? (Date.now() - userStreak.lastClaimedAt.getTime()) > BREAK_AFTER_HOURS * 60 * 60 * 1000
            : false;

        return {
            streak: userStreak
                ? { ...userStreak, status: isBroken ? StreakStatus.BROKEN : StreakStatus.ACTIVE, streakExpiresAt }
                : null,
            cycles,
        };
    }
}
