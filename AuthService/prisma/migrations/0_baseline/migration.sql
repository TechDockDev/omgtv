-- CreateEnum
CREATE TYPE "AuthProvider" AS ENUM ('FIREBASE', 'DLT');

-- CreateEnum
CREATE TYPE "AuthSubjectType" AS ENUM ('ADMIN', 'CUSTOMER', 'GUEST');

-- CreateEnum
CREATE TYPE "GuestLifecycleStatus" AS ENUM ('ACTIVE', 'MIGRATED');

-- CreateEnum
CREATE TYPE "OtpEvent" AS ENUM ('SEND_REQUESTED', 'DLT_API_SUCCESS', 'DLT_API_FAILED', 'VERIFY_ATTEMPT', 'VERIFY_SUCCESS', 'VERIFY_FAILED', 'EXPIRED', 'RATE_LIMITED');

-- CreateTable
CREATE TABLE "AdminCredential" (
    "subjectId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "passwordUpdatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminCredential_pkey" PRIMARY KEY ("subjectId")
);

-- CreateTable
CREATE TABLE "AuthSubject" (
    "id" TEXT NOT NULL,
    "type" "AuthSubjectType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthSubject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerIdentity" (
    "subjectId" TEXT NOT NULL,
    "firebaseUid" TEXT,
    "customerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastLoginAt" TIMESTAMP(3),
    "authProvider" "AuthProvider" NOT NULL DEFAULT 'FIREBASE',
    "phoneNumber" TEXT,

    CONSTRAINT "CustomerIdentity_pkey" PRIMARY KEY ("subjectId")
);

-- CreateTable
CREATE TABLE "GeneralSetting" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "supportEmail" TEXT,
    "helpCenterEmail" TEXT,
    "contactPhone" TEXT,
    "whatsappNumber" TEXT,
    "twitterHandle" TEXT,
    "facebookUrl" TEXT,
    "instagramHandle" TEXT,
    "companyName" TEXT,
    "businessAddress" TEXT,
    "updatedByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GeneralSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuestIdentity" (
    "subjectId" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "guestProfileId" TEXT NOT NULL,
    "status" "GuestLifecycleStatus" NOT NULL DEFAULT 'ACTIVE',
    "migratedToSubjectId" TEXT,
    "migratedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuestIdentity_pkey" PRIMARY KEY ("subjectId")
);

-- CreateTable
CREATE TABLE "OtpLog" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "event" "OtpEvent" NOT NULL,
    "subjectId" TEXT,
    "dltRequestId" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 1,
    "ip" TEXT,
    "deviceId" TEXT,
    "appVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OtpLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "deviceId" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminCredential_email_key" ON "AdminCredential"("email" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerIdentity_customerId_key" ON "CustomerIdentity"("customerId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerIdentity_firebaseUid_key" ON "CustomerIdentity"("firebaseUid" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerIdentity_phoneNumber_key" ON "CustomerIdentity"("phoneNumber" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "GuestIdentity_guestId_deviceId_key" ON "GuestIdentity"("guestId" ASC, "deviceId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "GuestIdentity_guestProfileId_key" ON "GuestIdentity"("guestProfileId" ASC);

-- CreateIndex
CREATE INDEX "OtpLog_event_createdAt_idx" ON "OtpLog"("event" ASC, "createdAt" ASC);

-- CreateIndex
CREATE INDEX "OtpLog_phone_createdAt_idx" ON "OtpLog"("phone" ASC, "createdAt" ASC);

-- CreateIndex
CREATE INDEX "OtpLog_subjectId_idx" ON "OtpLog"("subjectId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Session_refreshTokenHash_key" ON "Session"("refreshTokenHash" ASC);

-- CreateIndex
CREATE INDEX "Session_subjectId_idx" ON "Session"("subjectId" ASC);

-- AddForeignKey
ALTER TABLE "AdminCredential" ADD CONSTRAINT "AdminCredential_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "AuthSubject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerIdentity" ADD CONSTRAINT "CustomerIdentity_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "AuthSubject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuestIdentity" ADD CONSTRAINT "GuestIdentity_migratedToSubjectId_fkey" FOREIGN KEY ("migratedToSubjectId") REFERENCES "AuthSubject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuestIdentity" ADD CONSTRAINT "GuestIdentity_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "AuthSubject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OtpLog" ADD CONSTRAINT "OtpLog_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "CustomerIdentity"("subjectId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "AuthSubject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

