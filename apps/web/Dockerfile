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

# ── Production Stage ─────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy built app
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public
COPY --from=builder /app/templates ./templates
COPY --from=builder /app/apps/web/drizzle ./apps/web/drizzle
COPY --from=builder /app/apps/web/scripts ./apps/web/scripts
COPY --from=builder /app/apps/web/docker-entrypoint.sh ./apps/web/docker-entrypoint.sh

# The migration script runs BEFORE the app starts and uses ESM imports
# of postgres + drizzle-orm. Next.js standalone bundles these into webpack
# chunks (not node_modules), so they aren't resolvable by the script.
# Install them explicitly for the migrate script to use.
RUN pnpm add -P postgres drizzle-orm

# Create data directory
RUN mkdir -p /data/projects /data/templates
RUN chmod +x apps/web/docker-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["apps/web/docker-entrypoint.sh"]
