# syntax=docker/dockerfile:1
# Production image (deploy/compose.yaml, docs/deploy.md). CI uses this base image's Bun version;
# the digest pins the exact image.
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
# typescript is a peer dependency for typechecking only.
RUN bun install --frozen-lockfile --production --omit=peer

FROM base
# lame compresses finished call recordings to MP3 (src/adapters/storage/lame-compressor.ts). The
# upgrade picks up Debian fixes released since the base image was built.
RUN apt-get update && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends lame && rm -rf /var/lib/apt/lists/*
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
