-- CreateEnum
CREATE TYPE "dependency_node_kind" AS ENUM ('FRONTEND', 'GATEWAY', 'SERVICE', 'DATABASE', 'CACHE', 'QUEUE', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "dependency_origin" AS ENUM ('MANUAL', 'INFERRED');

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "dependency_version" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "dependency_nodes" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "label" VARCHAR(60) NOT NULL,
    "kind" "dependency_node_kind" NOT NULL,
    "origin" "dependency_origin" NOT NULL,
    "host" VARCHAR(253),
    "x" INTEGER NOT NULL,
    "y" INTEGER NOT NULL,

    CONSTRAINT "dependency_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dependency_edges" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "target_id" UUID NOT NULL,
    "origin" "dependency_origin" NOT NULL,
    "label" VARCHAR(60),

    CONSTRAINT "dependency_edges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dependency_nodes_project_id_idx" ON "dependency_nodes"("project_id");

-- CreateIndex
CREATE INDEX "dependency_edges_project_id_idx" ON "dependency_edges"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "dependency_edges_source_id_target_id_key" ON "dependency_edges"("source_id", "target_id");

-- AddForeignKey
ALTER TABLE "dependency_nodes" ADD CONSTRAINT "dependency_nodes_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dependency_edges" ADD CONSTRAINT "dependency_edges_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dependency_edges" ADD CONSTRAINT "dependency_edges_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "dependency_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dependency_edges" ADD CONSTRAINT "dependency_edges_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "dependency_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A node cannot depend on itself.
ALTER TABLE "dependency_edges" ADD CONSTRAINT "dependency_edges_no_self_loop"
    CHECK ("source_id" <> "target_id");
