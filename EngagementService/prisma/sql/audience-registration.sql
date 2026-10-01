-- CreateEnum
CREATE TYPE "AudienceRegistrationStatus" AS ENUM ('RECEIVED', 'WAITLISTED', 'SHORTLISTED', 'NOT_SELECTED');

-- CreateEnum
CREATE TYPE "AudienceFileKind" AS ENUM ('PHOTO', 'GROUP_PDF');

-- CreateTable
CREATE TABLE "AudienceConfig" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "bannerEnabled" BOOLEAN NOT NULL DEFAULT false,
    "bannerImageUrl" TEXT,
    "emailBannerImageUrl" TEXT,
    "title" TEXT,
    "subtitle" TEXT,
    "ctaLabel" TEXT,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "registrationOpen" BOOLEAN NOT NULL DEFAULT true,
    "updatedByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AudienceConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudienceRegistration" (
    "id" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "userId" TEXT,
    "leadMobile" TEXT NOT NULL,
    "status" "AudienceRegistrationStatus" NOT NULL DEFAULT 'RECEIVED',
    "groupSize" INTEGER NOT NULL,
    "city" TEXT NOT NULL,
    "consentVersion" TEXT NOT NULL,
    "consentAt" TIMESTAMP(3) NOT NULL,
    "deviceInfo" JSONB,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AudienceRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudienceRegistrationMember" (
    "id" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "fullName" TEXT NOT NULL,
    "age" INTEGER NOT NULL,
    "mobile" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "photoFileId" TEXT,

    CONSTRAINT "AudienceRegistrationMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudienceRegistrationFile" (
    "id" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "kind" "AudienceFileKind" NOT NULL,
    "ownerPosition" INTEGER,
    "storageKey" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AudienceRegistrationFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AudienceRegistration_referenceId_key" ON "AudienceRegistration"("referenceId");

-- CreateIndex
CREATE UNIQUE INDEX "AudienceRegistration_userId_key" ON "AudienceRegistration"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AudienceRegistration_leadMobile_key" ON "AudienceRegistration"("leadMobile");

-- CreateIndex
CREATE UNIQUE INDEX "AudienceRegistration_idempotencyKey_key" ON "AudienceRegistration"("idempotencyKey");

-- CreateIndex
CREATE INDEX "AudienceRegistration_status_idx" ON "AudienceRegistration"("status");

-- CreateIndex
CREATE INDEX "AudienceRegistration_city_idx" ON "AudienceRegistration"("city");

-- CreateIndex
CREATE INDEX "AudienceRegistration_createdAt_idx" ON "AudienceRegistration"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AudienceRegistrationMember_mobile_key" ON "AudienceRegistrationMember"("mobile");

-- CreateIndex
CREATE UNIQUE INDEX "AudienceRegistrationMember_registrationId_position_key" ON "AudienceRegistrationMember"("registrationId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "AudienceRegistrationFile_storageKey_key" ON "AudienceRegistrationFile"("storageKey");

-- CreateIndex
CREATE INDEX "AudienceRegistrationFile_registrationId_idx" ON "AudienceRegistrationFile"("registrationId");

-- AddForeignKey
ALTER TABLE "AudienceRegistrationMember" ADD CONSTRAINT "AudienceRegistrationMember_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "AudienceRegistration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudienceRegistrationFile" ADD CONSTRAINT "AudienceRegistrationFile_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "AudienceRegistration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

