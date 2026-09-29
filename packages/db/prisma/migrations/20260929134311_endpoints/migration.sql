-- CreateEnum
CREATE TYPE "http_method" AS ENUM ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS');

-- CreateTable
CREATE TABLE "endpoints" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "environment_id" UUID,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500),
    "method" "http_method" NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "headers" JSONB NOT NULL DEFAULT '[]',
    "query_params" JSONB NOT NULL DEFAULT '[]',
    "body" JSONB NOT NULL DEFAULT '{"type":"none"}',
    "auth" JSONB NOT NULL DEFAULT '{"type":"none"}',
    "timeout_ms" INTEGER NOT NULL DEFAULT 10000,
    "expected_status" INTEGER,
    "tags" VARCHAR(30)[] DEFAULT ARRAY[]::VARCHAR(30)[],
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "endpoints_project_id_idx" ON "endpoints"("project_id");

-- CreateIndex
CREATE INDEX "endpoints_environment_id_idx" ON "endpoints"("environment_id");

-- CreateIndex
CREATE UNIQUE INDEX "endpoints_project_id_name_key" ON "endpoints"("project_id", "name");

-- AddForeignKey
ALTER TABLE "endpoints" ADD CONSTRAINT "endpoints_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "endpoints" ADD CONSTRAINT "endpoints_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "endpoints" ADD CONSTRAINT "endpoints_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
