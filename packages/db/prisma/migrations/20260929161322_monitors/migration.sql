-- CreateEnum
CREATE TYPE "monitor_type" AS ENUM ('AVAILABILITY', 'STATUS', 'PERFORMANCE', 'RESPONSE_VALIDATION');

-- CreateTable
CREATE TABLE "monitors" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "environment_id" UUID,
    "name" VARCHAR(100) NOT NULL,
    "type" "monitor_type" NOT NULL,
    "interval_seconds" INTEGER NOT NULL,
    "timeout_ms" INTEGER NOT NULL,
    "expected_status" INTEGER,
    "latency_threshold_ms" INTEGER,
    "assertions" JSONB NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_run_at" TIMESTAMPTZ(3),
    "last_run_success" BOOLEAN,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "monitors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitor_runs" (
    "id" UUID NOT NULL,
    "monitor_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "environment_id" UUID,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "success" BOOLEAN NOT NULL,
    "status_code" INTEGER,
    "duration_ms" INTEGER,
    "size_bytes" INTEGER,
    "timed_out" BOOLEAN NOT NULL DEFAULT false,
    "failure_reason" VARCHAR(40),
    "failure_message" VARCHAR(500),

    CONSTRAINT "monitor_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "monitors_project_id_idx" ON "monitors"("project_id");

-- CreateIndex
CREATE INDEX "monitors_endpoint_id_idx" ON "monitors"("endpoint_id");

-- CreateIndex
CREATE INDEX "monitors_enabled_idx" ON "monitors"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "monitors_project_id_name_key" ON "monitors"("project_id", "name");

-- CreateIndex
CREATE INDEX "monitor_runs_monitor_id_started_at_idx" ON "monitor_runs"("monitor_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "monitor_runs_project_id_started_at_idx" ON "monitor_runs"("project_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "monitor_runs_started_at_idx" ON "monitor_runs"("started_at");

-- AddForeignKey
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitor_runs" ADD CONSTRAINT "monitor_runs_monitor_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitor_runs" ADD CONSTRAINT "monitor_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
