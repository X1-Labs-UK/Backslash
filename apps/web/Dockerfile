# ── Build Stage ──────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace config and all package.json files
COPY package.json pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY apps/ws/package.json apps/ws/
COPY packages/shared/package.json packages/shared/

# Install dependencies from workspace root
RUN pnpm install --no-frozen-lockfile

# Copy source
COPY packages/shared/ packages/shared/
COPY apps/web/ apps/web/
COPY templates/ templates/

# Build
WORKDIR /app/apps/web
RUN pnpm run build

# Prepare migration deps in an isolated directory (outside pnpm workspace)
# so they can be copied cleanly to the production image.
RUN mkdir -p /migrate-deps && cd /migrate-deps \
    && npm init -y && npm install --production postgres drizzle-orm

# ── Production Stage ─────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Copy built app
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public
COPY --from=builder /app/templates ./templates
COPY --from=builder /app/apps/web/drizzle ./apps/web/drizzle
COPY --from=builder /app/apps/web/scripts ./apps/web/scripts
COPY --from=builder /app/apps/web/docker-entrypoint.sh ./apps/web/docker-entrypoint.sh

# Migration deps — isolated from standalone's node_modules
COPY --from=builder /migrate-deps/node_modules ./migrate-deps/node_modules

# Create data directory
RUN mkdir -p /data/projects /data/templates
RUN chmod +x apps/web/docker-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["apps/web/docker-entrypoint.sh"]
