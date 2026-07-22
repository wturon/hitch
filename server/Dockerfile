# @hitch/server container image. Build context is the REPO ROOT (workspace
# install needs the root package.json + lockfile):
#   docker build -f server/Dockerfile .
# Railway builds this same file; docker-compose.yml wires it for self-host.

# --- build stage: install (with dev deps) + tsc ------------------------------
FROM node:24-slim AS build
WORKDIR /app

# Workspace-aware install: npm ci needs the root manifest + lockfile and every
# workspace's package.json (even the ones we don't install) to validate the
# tree. -w filters the actual install to server + shared.
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY shared/package.json shared/package.json
COPY daemon/package.json daemon/package.json
COPY desktop/package.json desktop/package.json
RUN npm ci -w @hitch/server -w @hitch/shared --ignore-scripts

# Build server first (shared's typecheck consumes server's emitted .d.ts),
# then shared — building shared here is a compile-time contract check only;
# the runtime image ships server alone.
COPY server/ server/
COPY shared/ shared/
RUN npm run build -w @hitch/server && npm run build -w @hitch/shared

# --- runtime stage: prod deps + dist + migrations ----------------------------
FROM node:24-slim
ENV NODE_ENV=production
# Run drizzle migrations before serving — default ON in the container.
ENV MIGRATE_ON_BOOT=1
WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY shared/package.json shared/package.json
COPY daemon/package.json daemon/package.json
COPY desktop/package.json desktop/package.json
RUN npm ci -w @hitch/server --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/server/dist server/dist
# Migrations ride along for MIGRATE_ON_BOOT (index.js resolves ../drizzle).
COPY server/drizzle server/drizzle

EXPOSE 3010
CMD ["node", "server/dist/index.js"]
