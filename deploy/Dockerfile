# Production-ish image. Music/data MUST be mounted from the host.
# This image never installs Ollama.
FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@10.33.3 --activate

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json tsconfig.typecheck.json vitest.config.ts .nvmrc ./
COPY apps ./apps
COPY packages ./packages
COPY config ./config
COPY docs ./docs

RUN pnpm install --frozen-lockfile \
  && pnpm --filter @subwave-ai/web build

ENV NODE_ENV=production \
    SUBWAVE_WEB_DIST=/app/apps/web/dist \
    SUBWAVE_CONFIG=/var/lib/subwave/config/subwave.yaml \
    SUBWAVE_SECRETS_DIR=/var/lib/subwave/secrets \
    SUBWAVE_DB_PATH=/var/lib/subwave/data/subwave.sqlite \
    SUBWAVE_DOWNLOADS_DIR=/var/lib/subwave/data/downloads \
    SUBWAVE_STAGING_DIR=/var/lib/subwave/data/staging \
    SUBWAVE_LIBRARY_DIR=/var/lib/subwave/library \
    SUBWAVE_API_HOST=0.0.0.0 \
    SUBWAVE_API_PORT=8788

EXPOSE 8788
CMD ["pnpm", "--filter", "@subwave-ai/api", "start"]
