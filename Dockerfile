# syntax=docker/dockerfile:1.7
# Multi-target build for the TraceLayer monorepo.
#   docker build --target backend  .
#   docker build --target worker   .
#   docker build --target frontend .

FROM node:22-bookworm-slim AS base
# openssl is required by the Prisma query engine.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PRISMA_HIDE_UPDATE_MESSAGE=1
RUN corepack enable && corepack prepare pnpm@10.5.2 --activate
WORKDIR /app

# ── Dependencies (cached until a manifest or the lockfile changes)
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/backend/package.json apps/backend/
COPY apps/worker/package.json apps/worker/
COPY apps/frontend/package.json apps/frontend/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ── Server-side build: shared → db (prisma generate) → backend, worker
FROM deps AS server-build
COPY tsconfig.base.json tsconfig.node.json ./
COPY packages ./packages
COPY apps/backend ./apps/backend
COPY apps/worker ./apps/worker
RUN pnpm --filter @tracelayer/shared build \
  && pnpm --filter @tracelayer/db build \
  && pnpm --filter @tracelayer/backend build \
  && pnpm --filter @tracelayer/worker build

FROM server-build AS backend
ENV NODE_ENV=production
EXPOSE 4000
# Apply pending migrations, then start the API. Only the backend runs migrations.
CMD ["sh", "-c", "pnpm --filter @tracelayer/db exec prisma migrate deploy && exec node apps/backend/dist/server.js"]

FROM server-build AS worker
ENV NODE_ENV=production
CMD ["node", "apps/worker/dist/index.js"]

# ── Frontend: static build served by nginx
FROM deps AS frontend-build
COPY tsconfig.base.json tsconfig.node.json ./
COPY packages/shared ./packages/shared
COPY apps/frontend ./apps/frontend
RUN pnpm --filter @tracelayer/frontend build

FROM nginx:1.27-alpine AS frontend
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=frontend-build /app/apps/frontend/dist /usr/share/nginx/html
EXPOSE 80
