-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "deletedAt" TIMESTAMP(3) DEFAULT '9999-12-12 00:00:00 +00:00',
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3),
    "available" BOOLEAN NOT NULL DEFAULT true,
    "body" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "enterpriseId" TEXT NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enterprises" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "deletedAt" TIMESTAMP(3) DEFAULT '9999-12-12 00:00:00 +00:00',
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3),
    "available" BOOLEAN NOT NULL DEFAULT true,
    "name" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,

    CONSTRAINT "enterprises_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "messages_trigger_key" ON "messages"("trigger");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_enterpriseId_fkey" FOREIGN KEY ("enterpriseId") REFERENCES "enterprises"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
