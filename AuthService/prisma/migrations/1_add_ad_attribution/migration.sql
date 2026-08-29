-- AlterTable
ALTER TABLE "CustomerIdentity" ADD COLUMN     "adId" TEXT,
ADD COLUMN     "adsetId" TEXT,
ADD COLUMN     "attributionSource" TEXT,
ADD COLUMN     "campaignId" TEXT;

-- AlterTable
ALTER TABLE "GuestIdentity" ADD COLUMN     "adId" TEXT,
ADD COLUMN     "adsetId" TEXT,
ADD COLUMN     "attributionSource" TEXT,
ADD COLUMN     "campaignId" TEXT;

-- CreateTable
CREATE TABLE "AttributionEvent" (
    "id" TEXT NOT NULL,
    "guestId" TEXT,
    "customerId" TEXT,
    "eventType" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "campaignId" TEXT,
    "adsetId" TEXT,
    "adId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttributionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AttributionEvent_customerId_idx" ON "AttributionEvent"("customerId");

-- CreateIndex
CREATE INDEX "AttributionEvent_guestId_idx" ON "AttributionEvent"("guestId");

-- CreateIndex
CREATE INDEX "AttributionEvent_occurredAt_idx" ON "AttributionEvent"("occurredAt");

