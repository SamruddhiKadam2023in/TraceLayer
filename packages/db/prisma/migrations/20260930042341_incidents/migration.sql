-- CreateEnum
CREATE TYPE "incident_status" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'INVESTIGATING', 'IDENTIFIED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "incident_event_type" AS ENUM ('DETECTED', 'ALERT_FIRED', 'ALERT_RESOLVED', 'STATUS_CHANGED', 'SEVERITY_CHANGED', 'ASSIGNED', 'COMMENT');

-- AlterTable
ALTER TABLE "alerts" ADD COLUMN     "incident_id" UUID;

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "incident_counter" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "incidents" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "monitor_id" UUID,
    "title" VARCHAR(300) NOT NULL,
    "severity" "severity" NOT NULL,
    "status" "incident_status" NOT NULL DEFAULT 'OPEN',
    "assignee_id" UUID,
    "detected_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledged_at" TIMESTAMPTZ(3),
    "resolved_at" TIMESTAMPTZ(3),
    "resolved_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incident_events" (
    "id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "type" "incident_event_type" NOT NULL,
    "actor_id" UUID,
    "message" VARCHAR(2000),
    "from_value" VARCHAR(100),
    "to_value" VARCHAR(100),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incident_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "incidents_project_id_status_idx" ON "incidents"("project_id", "status");

-- CreateIndex
CREATE INDEX "incidents_project_id_detected_at_idx" ON "incidents"("project_id", "detected_at" DESC);

-- CreateIndex
CREATE INDEX "incidents_monitor_id_status_idx" ON "incidents"("monitor_id", "status");

-- CreateIndex
CREATE INDEX "incidents_assignee_id_idx" ON "incidents"("assignee_id");

-- CreateIndex
CREATE UNIQUE INDEX "incidents_project_id_number_key" ON "incidents"("project_id", "number");

-- CreateIndex
CREATE INDEX "incident_events_incident_id_created_at_idx" ON "incident_events"("incident_id", "created_at");

-- CreateIndex
CREATE INDEX "alerts_incident_id_idx" ON "alerts"("incident_id");

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incidents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_monitor_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A resolved incident always has a resolution time, and an active one never does.
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_resolved_at_check"
    CHECK (("status" = 'RESOLVED') = ("resolved_at" IS NOT NULL));
