# ID Resolver V1 image. Build context: repository root (npm workspaces).
# Two stages: the build stage compiles TypeScript with dev dependencies; the
# runtime stage has production dependencies only. No secrets are copied in;
# .env files are excluded by .dockerignore. Migrations are NOT run on start:
# railway.json runs them as a separate preDeployCommand.
# Single-process runtime (CHR-70): one Node process serves the API and runs
# every resolution job; NODE_OPTIONS caps its heap.

# ---- Stage 1: build ---------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci --workspace @idr/resolver --include-workspace-root=false --ignore-scripts
RUN npm run build --workspace @idr/resolver
# Every workspace manifest (and the lockfile) so the runtime `npm ci -w` can
# validate the lockfile without copying other workspaces' sources.
RUN mkdir -p /manifests && cp package.json package-lock.json /manifests/ \
 && find apps packages integrations -name package.json -not -path "*/node_modules/*" 2>/dev/null \
    | xargs -r -I{} cp --parents {} /manifests/

# ---- Stage 2: runtime -------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=256
COPY --from=build /manifests/ ./
# --ignore-scripts: no dependency install hooks run in the image.
RUN npm ci --workspace @idr/resolver --include-workspace-root=false --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/apps/resolver/dist apps/resolver/dist
COPY apps/resolver/migrations apps/resolver/migrations
COPY apps/resolver/scripts/entrypoint.sh apps/resolver/scripts/entrypoint.sh
RUN chmod 0755 apps/resolver/scripts/entrypoint.sh
WORKDIR /app/apps/resolver
# The official image already contains the unprivileged "node" user (uid 1000).
USER node
EXPOSE 8080
ENTRYPOINT ["/app/apps/resolver/scripts/entrypoint.sh"]
CMD ["node", "dist/main.js"]
