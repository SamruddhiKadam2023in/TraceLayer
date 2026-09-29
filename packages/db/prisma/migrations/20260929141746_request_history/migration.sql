-- CreateTable
CREATE TABLE "request_history" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "endpoint_id" UUID,
    "environment_id" UUID,
    "user_id" UUID,
    "method" "http_method" NOT NULL,
    "url" VARCHAR(4096) NOT NULL,
    "status" INTEGER,
    "error_code" VARCHAR(40),
    "error_message" VARCHAR(500),
    "duration_ms" INTEGER NOT NULL,
    "size_bytes" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "request_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "request_history_project_id_created_at_idx" ON "request_history"("project_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "request_history_endpoint_id_created_at_idx" ON "request_history"("endpoint_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "request_history" ADD CONSTRAINT "request_history_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_history" ADD CONSTRAINT "request_history_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "endpoints"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_history" ADD CONSTRAINT "request_history_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_history" ADD CONSTRAINT "request_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
