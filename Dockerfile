# syntax=docker/dockerfile:1
# Production image (deploy/compose.yaml, docs/deploy.md). The Bun version must match .bun-version
# (CI checks it); the digest pins the exact image.
FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
# typescript is a peer dependency for typechecking only.
RUN bun install --frozen-lockfile --production --omit=peer

FROM base
ENV NODE_ENV=production \
    BIND_HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data \
    CONFIG_DIR=/app/config
COPY --from=deps /app/node_modules node_modules
COPY package.json bun.lock tsconfig.json LICENSE NOTICE ./
# src includes src/web/client: the browser code is compiled at startup (src/runtime/client-assets.ts).
COPY src src
COPY config config
COPY drizzle drizzle
# The real calls played at /listen (src/web/listen.ts): redacted audio and transcripts.
COPY demos/calls demos/calls
COPY scripts/control.ts scripts/backup-db.ts scripts/
# The VPS deploy script reads the Compose file from the image it deploys.
COPY deploy/compose.yaml deploy/compose.yaml
USER bun
EXPOSE 8787
CMD ["bun", "src/runtime/bun.ts"]
