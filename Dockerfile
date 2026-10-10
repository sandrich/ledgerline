# syntax=docker/dockerfile:1
# ledgerline: one image for both processes (web UI + API, and the background worker).
# See docker-compose.yml for how the two services are started from it.

ARG NODE_VERSION=22

# ---- build: install all deps (compiles better-sqlite3 if needed), build Next.js, drop dev deps ----
FROM node:${NODE_VERSION}-bookworm-slim AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build \
  && npm prune --omit=dev --no-audit --no-fund \
  && node -e "new (require('better-sqlite3'))(':memory:').prepare('select 1').get()" \
  && rm -rf .next/cache

# ---- runtime: no compilers, non-root ----
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOST=0.0.0.0 \
    PORT=8790 \
    DATABASE_PATH=/app/data/portfolio.db
# The worker runs the TypeScript sources with tsx (a production dependency) and the migrations read
# lib/db/schema.sql at runtime, so the whole pruned app directory is copied.
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8790)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "exec node_modules/.bin/next start -H 0.0.0.0 -p \"$PORT\""]
