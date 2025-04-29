-- CreateTable
CREATE TABLE "prompt" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "deletedAt" TIMESTAMP(3) DEFAULT '9999-12-12 00:00:00 +00:00',
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3),
    "available" BOOLEAN NOT NULL DEFAULT true,
    "body" TEXT NOT NULL,
    "enterpriseId" TEXT NOT NULL,

    CONSTRAINT "prompt_pkey" PRIMARY KEY ("id")
);
