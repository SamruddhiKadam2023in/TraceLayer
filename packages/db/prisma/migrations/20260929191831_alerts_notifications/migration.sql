-- CreateEnum
CREATE TYPE "alert_metric" AS ENUM ('LATENCY_P95', 'ERROR_RATE', 'UPTIME', 'STATUS_CODE', 'RESPONSE_TIME', 'CONSECUTIVE_FAILURES');

-- CreateEnum
CREATE TYPE "severity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "alert_rule_state" AS ENUM ('OK', 'PENDING', 'FIRING');

-- CreateEnum
CREATE TYPE "alert_status" AS ENUM ('FIRING', 'RESOLVED');

-- CreateEnum
CREATE TYPE "channel_type" AS ENUM ('EMAIL');

-- CreateEnum
CREATE TYPE "notification_event" AS ENUM ('ALERT_FIRED', 'ALERT_RESOLVED', 'TEST');

-- CreateEnum
CREATE TYPE "notification_status" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "alert_rules" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "monitor_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "metric" "alert_metric" NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "severity" "severity" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "state" "alert_rule_state" NOT NULL DEFAULT 'OK',
    "pending_since" TIMESTAMPTZ(3),
    "last_value" DOUBLE PRECISION,
    "last_evaluated_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "alert_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" UUID NOT NULL,
    "rule_id" UUID,
    "monitor_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "severity" "severity" NOT NULL,
    "status" "alert_status" NOT NULL DEFAULT 'FIRING',
    "value" DOUBLE PRECISION,
    "threshold" DOUBLE PRECISION NOT NULL,
    "message" VARCHAR(500) NOT NULL,
    "fired_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_channels" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "type" "channel_type" NOT NULL,
    "config" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_rule_channels" (
    "rule_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,

    CONSTRAINT "alert_rule_channels_pkey" PRIMARY KEY ("rule_id","channel_id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "alert_id" UUID,
    "event" "notification_event" NOT NULL,
    "status" "notification_status" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" VARCHAR(500),
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "alert_rules_monitor_id_idx" ON "alert_rules"("monitor_id");

-- CreateIndex
CREATE INDEX "alert_rules_project_id_idx" ON "alert_rules"("project_id");

-- CreateIndex
CREATE INDEX "alerts_project_id_fired_at_idx" ON "alerts"("project_id", "fired_at" DESC);

-- CreateIndex
CREATE INDEX "alerts_rule_id_status_idx" ON "alerts"("rule_id", "status");

-- CreateIndex
CREATE INDEX "notification_channels_workspace_id_idx" ON "notification_channels"("workspace_id");

-- CreateIndex
CREATE INDEX "alert_rule_channels_channel_id_idx" ON "alert_rule_channels"("channel_id");

-- CreateIndex
CREATE INDEX "notifications_channel_id_created_at_idx" ON "notifications"("channel_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "notifications_alert_id_idx" ON "notifications"("alert_id");

-- AddForeignKey
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_monitor_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "alert_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_monitor_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_rule_channels" ADD CONSTRAINT "alert_rule_channels_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "alert_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_rule_channels" ADD CONSTRAINT "alert_rule_channels_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "notification_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "notification_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "alerts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
