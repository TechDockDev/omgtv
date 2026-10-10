-- Apple IAP support. Purely additive — three new nullable columns, no
-- existing column, index or constraint touched. Safe to run against the
-- live, non-empty prod database with `prisma db execute --file`.

ALTER TABLE "SubscriptionPlan" ADD COLUMN "appleProductId" TEXT;

ALTER TABLE "UserSubscription" ADD COLUMN "appleOriginalTransactionId" TEXT;
CREATE INDEX "UserSubscription_appleOriginalTransactionId_idx" ON "UserSubscription"("appleOriginalTransactionId");

ALTER TABLE "Transaction" ADD COLUMN "appleTransactionId" TEXT;
CREATE INDEX "Transaction_appleTransactionId_idx" ON "Transaction"("appleTransactionId");
