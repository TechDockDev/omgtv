-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('PENDING', 'ACTIVE', 'EXPIRED', 'CANCELED', 'TRIAL', 'PAUSED');

-- CreateEnum
CREATE TYPE "PhonePeRedemptionStatus" AS ENUM ('PENDING_NOTIFY', 'NOTIFIED', 'EXECUTING', 'SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "WalletStatus" AS ENUM ('ACTIVE', 'BLOCKED');

-- CreateEnum
CREATE TYPE "CoinTransactionType" AS ENUM ('CREDIT', 'DEBIT');

-- CreateEnum
CREATE TYPE "TransactionSource" AS ENUM ('PURCHASE', 'UNLOCK', 'ADMIN', 'AD', 'EXPIRY', 'STREAK', 'STREAK_BONUS');

-- CreateEnum
CREATE TYPE "StreakStatus" AS ENUM ('ACTIVE', 'BROKEN');

-- CreateEnum
CREATE TYPE "PurchaseStatus" AS ENUM ('CREATED', 'SUCCESS', 'FAILED');

-- CreateTable
CREATE TABLE "SubscriptionPlan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "pricePaise" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "durationDays" INTEGER NOT NULL,
    "reelsLimit" INTEGER,
    "episodesLimit" INTEGER,
    "seriesLimit" INTEGER,
    "accessLevel" TEXT,
    "isUnlimitedReels" BOOLEAN NOT NULL DEFAULT false,
    "isUnlimitedEpisodes" BOOLEAN NOT NULL DEFAULT false,
    "isUnlimitedSeries" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "features" TEXT[],
    "isPopular" BOOLEAN NOT NULL DEFAULT false,
    "subscriberCount" INTEGER NOT NULL DEFAULT 0,
    "icon" TEXT,
    "savings" INTEGER NOT NULL DEFAULT 0,
    "cancelledPricePaise" INTEGER,
    "subscriptionViaTrial" BOOLEAN NOT NULL DEFAULT false,
    "razorpayPlanId" TEXT,
    "appleProductId" TEXT,
    "promoVideoUrl" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrialPlan" (
    "id" TEXT NOT NULL,
    "trialPricePaise" INTEGER NOT NULL,
    "cancelledTrialPricePaise" INTEGER,
    "durationDays" INTEGER NOT NULL,
    "reminderDays" INTEGER NOT NULL,
    "isAutoDebit" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrialPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FreePlanConfig" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "maxFreeReels" INTEGER NOT NULL DEFAULT 5,
    "maxFreeEpisodes" INTEGER NOT NULL DEFAULT 3,
    "maxFreeSeries" INTEGER NOT NULL DEFAULT 1,
    "updatedByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FreePlanConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planId" TEXT,
    "trialPlanId" TEXT,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'PENDING',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "razorpayOrderId" TEXT,
    "transactionId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'razorpay',
    "phonePeSubscriptionId" TEXT,
    "mandateMaxAmount" INTEGER,
    "appleOriginalTransactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planId" TEXT,
    "amountPaise" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "razorpayPlanId" TEXT,
    "razorpayPaymentId" TEXT,
    "razorpaySignature" TEXT,
    "subscriptionId" TEXT,
    "trialPlanId" TEXT,
    "failureReason" TEXT,
    "metadata" JSONB,
    "provider" TEXT NOT NULL DEFAULT 'razorpay',
    "appleTransactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhonePeRedemption" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userSubscriptionId" TEXT NOT NULL,
    "merchantSubscriptionId" TEXT NOT NULL,
    "merchantOrderId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "isTrialCycle" BOOLEAN NOT NULL DEFAULT false,
    "cycleNumber" INTEGER NOT NULL,
    "mandateMaxAmount" INTEGER NOT NULL DEFAULT 50000,
    "scheduledNotifyAt" TIMESTAMP(3) NOT NULL,
    "status" "PhonePeRedemptionStatus" NOT NULL DEFAULT 'PENDING_NOTIFY',
    "notifiedAt" TIMESTAMP(3),
    "notifyWindowEnd" TIMESTAMP(3),
    "executeAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastStatusCheckedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PhonePeRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhonePeEventLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "merchantOrderId" TEXT,
    "merchantSubscriptionId" TEXT,
    "eventType" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "request" JSONB,
    "response" JSONB,
    "httpStatus" INTEGER,
    "success" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PhonePeEventLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionGlobalConfig" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "promoVideoUrl" TEXT,
    "restrictRepeatTrials" BOOLEAN NOT NULL DEFAULT false,
    "phonePayIosPayment" BOOLEAN NOT NULL DEFAULT true,
    "updatedByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionGlobalConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminSecurityVerification" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminSecurityVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserWallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "WalletStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoinTransaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "CoinTransactionType" NOT NULL,
    "source" "TransactionSource" NOT NULL,
    "amount" INTEGER NOT NULL,
    "remainingAmount" INTEGER,
    "referenceId" TEXT,
    "expiryAt" TIMESTAMP(3),
    "metadata" JSONB,
    "reminderSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoinTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoinBundle" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "coins" INTEGER NOT NULL,
    "price" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoinBundle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserCoinPurchase" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "orderId" TEXT,
    "paymentId" TEXT,
    "amountPaid" INTEGER NOT NULL,
    "coins" INTEGER NOT NULL,
    "status" "PurchaseStatus" NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserCoinPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdCoinConfig" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "coinsPerAd" INTEGER NOT NULL DEFAULT 5,
    "dailyLimit" INTEGER NOT NULL DEFAULT 3,
    "expiryHours" INTEGER,
    "updatedByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdCoinConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserEpisodeUnlock" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserEpisodeUnlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StreakConfig" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "coinsPerDay" INTEGER NOT NULL DEFAULT 10,
    "coinExpiryHours" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StreakConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StreakMilestone" (
    "id" TEXT NOT NULL,
    "configVersion" INTEGER NOT NULL,
    "dayNumber" INTEGER NOT NULL,
    "bonusCoins" INTEGER NOT NULL,
    "bonusExpiryHours" INTEGER,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StreakMilestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserStreak" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "currentDay" INTEGER NOT NULL DEFAULT 1,
    "lastClaimedAt" TIMESTAMP(3),
    "cyclesCompleted" INTEGER NOT NULL DEFAULT 0,
    "cycleStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "configVersion" INTEGER NOT NULL,
    "status" "StreakStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastBrokeAtDay" INTEGER,
    "streakReminderSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserStreak_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StreakClaimLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dayNumber" INTEGER NOT NULL,
    "coinsEarned" INTEGER NOT NULL,
    "bonusEarned" INTEGER NOT NULL DEFAULT 0,
    "milestoneId" TEXT,
    "cycleNumber" INTEGER NOT NULL,
    "configVersion" INTEGER NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StreakClaimLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FreePlanConfig_id_key" ON "FreePlanConfig"("id");

-- CreateIndex
CREATE INDEX "UserSubscription_userId_status_idx" ON "UserSubscription"("userId", "status");

-- CreateIndex
CREATE INDEX "UserSubscription_planId_idx" ON "UserSubscription"("planId");

-- CreateIndex
CREATE INDEX "UserSubscription_provider_idx" ON "UserSubscription"("provider");

-- CreateIndex
CREATE INDEX "UserSubscription_phonePeSubscriptionId_idx" ON "UserSubscription"("phonePeSubscriptionId");

-- CreateIndex
CREATE INDEX "UserSubscription_appleOriginalTransactionId_idx" ON "UserSubscription"("appleOriginalTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "UserSubscription_transactionId_key" ON "UserSubscription"("transactionId");

-- CreateIndex
CREATE INDEX "Transaction_userId_status_idx" ON "Transaction"("userId", "status");

-- CreateIndex
CREATE INDEX "Transaction_razorpayPlanId_idx" ON "Transaction"("razorpayPlanId");

-- CreateIndex
CREATE INDEX "Transaction_subscriptionId_idx" ON "Transaction"("subscriptionId");

-- CreateIndex
CREATE INDEX "Transaction_razorpayPaymentId_idx" ON "Transaction"("razorpayPaymentId");

-- CreateIndex
CREATE INDEX "Transaction_provider_idx" ON "Transaction"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_appleTransactionId_key" ON "Transaction"("appleTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "PhonePeRedemption_merchantOrderId_key" ON "PhonePeRedemption"("merchantOrderId");

-- CreateIndex
CREATE INDEX "PhonePeRedemption_userId_idx" ON "PhonePeRedemption"("userId");

-- CreateIndex
CREATE INDEX "PhonePeRedemption_userSubscriptionId_idx" ON "PhonePeRedemption"("userSubscriptionId");

-- CreateIndex
CREATE INDEX "PhonePeRedemption_status_scheduledNotifyAt_idx" ON "PhonePeRedemption"("status", "scheduledNotifyAt");

-- CreateIndex
CREATE INDEX "PhonePeRedemption_status_notifiedAt_idx" ON "PhonePeRedemption"("status", "notifiedAt");

-- CreateIndex
CREATE INDEX "PhonePeRedemption_status_updatedAt_idx" ON "PhonePeRedemption"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PhonePeRedemption_userSubscriptionId_cycleNumber_key" ON "PhonePeRedemption"("userSubscriptionId", "cycleNumber");

-- CreateIndex
CREATE UNIQUE INDEX "PhonePeRedemption_userSubscriptionId_scheduledNotifyAt_key" ON "PhonePeRedemption"("userSubscriptionId", "scheduledNotifyAt");

-- CreateIndex
CREATE INDEX "PhonePeEventLog_merchantOrderId_idx" ON "PhonePeEventLog"("merchantOrderId");

-- CreateIndex
CREATE INDEX "PhonePeEventLog_merchantSubscriptionId_idx" ON "PhonePeEventLog"("merchantSubscriptionId");

-- CreateIndex
CREATE INDEX "PhonePeEventLog_userId_idx" ON "PhonePeEventLog"("userId");

-- CreateIndex
CREATE INDEX "PhonePeEventLog_createdAt_idx" ON "PhonePeEventLog"("createdAt");

-- CreateIndex
CREATE INDEX "PhonePeEventLog_eventType_idx" ON "PhonePeEventLog"("eventType");

-- CreateIndex
CREATE INDEX "PhonePeEventLog_createdAt_eventType_idx" ON "PhonePeEventLog"("createdAt", "eventType");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionGlobalConfig_id_key" ON "SubscriptionGlobalConfig"("id");

-- CreateIndex
CREATE UNIQUE INDEX "AdminSecurityVerification_adminId_key" ON "AdminSecurityVerification"("adminId");

-- CreateIndex
CREATE INDEX "AdminSecurityVerification_expiresAt_idx" ON "AdminSecurityVerification"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserWallet_userId_key" ON "UserWallet"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CoinTransaction_referenceId_key" ON "CoinTransaction"("referenceId");

-- CreateIndex
CREATE INDEX "CoinTransaction_userId_idx" ON "CoinTransaction"("userId");

-- CreateIndex
CREATE INDEX "CoinTransaction_userId_expiryAt_idx" ON "CoinTransaction"("userId", "expiryAt");

-- CreateIndex
CREATE INDEX "CoinTransaction_userId_type_remainingAmount_idx" ON "CoinTransaction"("userId", "type", "remainingAmount");

-- CreateIndex
CREATE INDEX "CoinTransaction_expiryAt_reminderSentAt_idx" ON "CoinTransaction"("expiryAt", "reminderSentAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserCoinPurchase_paymentId_key" ON "UserCoinPurchase"("paymentId");

-- CreateIndex
CREATE INDEX "UserCoinPurchase_userId_idx" ON "UserCoinPurchase"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserCoinPurchase_orderId_key" ON "UserCoinPurchase"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "AdCoinConfig_id_key" ON "AdCoinConfig"("id");

-- CreateIndex
CREATE UNIQUE INDEX "UserEpisodeUnlock_userId_episodeId_key" ON "UserEpisodeUnlock"("userId", "episodeId");

-- CreateIndex
CREATE UNIQUE INDEX "StreakConfig_id_key" ON "StreakConfig"("id");

-- CreateIndex
CREATE INDEX "StreakMilestone_configVersion_isEnabled_idx" ON "StreakMilestone"("configVersion", "isEnabled");

-- CreateIndex
CREATE UNIQUE INDEX "StreakMilestone_configVersion_dayNumber_key" ON "StreakMilestone"("configVersion", "dayNumber");

-- CreateIndex
CREATE UNIQUE INDEX "UserStreak_userId_key" ON "UserStreak"("userId");

-- CreateIndex
CREATE INDEX "UserStreak_status_idx" ON "UserStreak"("status");

-- CreateIndex
CREATE INDEX "UserStreak_configVersion_idx" ON "UserStreak"("configVersion");

-- CreateIndex
CREATE INDEX "UserStreak_lastClaimedAt_idx" ON "UserStreak"("lastClaimedAt");

-- CreateIndex
CREATE INDEX "UserStreak_lastClaimedAt_streakReminderSentAt_idx" ON "UserStreak"("lastClaimedAt", "streakReminderSentAt");

-- CreateIndex
CREATE INDEX "StreakClaimLog_userId_idx" ON "StreakClaimLog"("userId");

-- CreateIndex
CREATE INDEX "StreakClaimLog_userId_claimedAt_idx" ON "StreakClaimLog"("userId", "claimedAt");

-- CreateIndex
CREATE INDEX "StreakClaimLog_dayNumber_idx" ON "StreakClaimLog"("dayNumber");

-- CreateIndex
CREATE INDEX "StreakClaimLog_milestoneId_idx" ON "StreakClaimLog"("milestoneId");

-- AddForeignKey
ALTER TABLE "UserSubscription" ADD CONSTRAINT "UserSubscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SubscriptionPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSubscription" ADD CONSTRAINT "UserSubscription_trialPlanId_fkey" FOREIGN KEY ("trialPlanId") REFERENCES "TrialPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSubscription" ADD CONSTRAINT "UserSubscription_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SubscriptionPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_trialPlanId_fkey" FOREIGN KEY ("trialPlanId") REFERENCES "TrialPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhonePeRedemption" ADD CONSTRAINT "PhonePeRedemption_userSubscriptionId_fkey" FOREIGN KEY ("userSubscriptionId") REFERENCES "UserSubscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

