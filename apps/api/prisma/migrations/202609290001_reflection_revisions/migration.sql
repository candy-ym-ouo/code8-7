-- CreateEnum
CREATE TYPE "ReflectionRevisionKind" AS ENUM ('INITIAL', 'UPDATED', 'RESTORED_HISTORY');

-- AlterEnum
ALTER TYPE "ActivityAction" ADD VALUE 'REVISION_RESTORED';

-- CreateTable
CREATE TABLE "completion_reflection_revisions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "reflection_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "revision_number" INTEGER NOT NULL,
    "kind" "ReflectionRevisionKind" NOT NULL,
    "mood_tags" "MoodTag"[] NOT NULL,
    "reflection" TEXT,
    "version" INTEGER NOT NULL,
    "restored_from_revision" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "completion_reflection_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "completion_reflection_revisions_reflection_id_revision_key" ON "completion_reflection_revisions"("reflection_id", "revision_number");

-- CreateIndex
CREATE INDEX "completion_reflection_revisions_user_id_created_at_idx" ON "completion_reflection_revisions"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "completion_reflection_revisions" ADD CONSTRAINT "completion_reflection_revisions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "completion_reflection_revisions" ADD CONSTRAINT "completion_reflection_revisions_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "completion_reflection_revisions" ADD CONSTRAINT "completion_reflection_revisions_reflection_id_fkey" FOREIGN KEY ("reflection_id") REFERENCES "completion_reflections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
