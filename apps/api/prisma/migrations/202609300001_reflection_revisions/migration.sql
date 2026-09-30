-- AlterEnum
ALTER TYPE "ActivityAction" ADD VALUE 'REVISION_RESTORED';

-- CreateEnum
CREATE TYPE "RevisionAction" AS ENUM ('INITIAL', 'UPDATED', 'DELETED', 'RESTORED', 'VERSION_RESTORED');

-- CreateTable
CREATE TABLE "reflection_revisions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "reflection_id" UUID NOT NULL,
    "revision_no" INTEGER NOT NULL,
    "action" "RevisionAction" NOT NULL,
    "mood_tags" "MoodTag"[] NOT NULL,
    "reflection" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reflection_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reflection_revisions_reflection_id_revision_no_key" ON "reflection_revisions"("reflection_id", "revision_no");

-- CreateIndex
CREATE INDEX "reflection_revisions_user_id_created_at_idx" ON "reflection_revisions"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "reflection_revisions_book_id_reflection_id_revision_no_idx" ON "reflection_revisions"("book_id", "reflection_id", "revision_no");

-- AddForeignKey
ALTER TABLE "reflection_revisions" ADD CONSTRAINT "reflection_revisions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reflection_revisions" ADD CONSTRAINT "reflection_revisions_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reflection_revisions" ADD CONSTRAINT "reflection_revisions_reflection_id_fkey" FOREIGN KEY ("reflection_id") REFERENCES "completion_reflections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill an INITIAL revision for every existing reflection (including soft-deleted ones).
INSERT INTO "reflection_revisions" ("id", "user_id", "book_id", "reflection_id", "revision_no", "action", "mood_tags", "reflection", "created_at")
SELECT
    gen_random_uuid(),
    r."user_id",
    r."book_id",
    r."id",
    1,
    'INITIAL'::"RevisionAction",
    r."mood_tags",
    r."reflection",
    r."created_at"
FROM "completion_reflections" r;
