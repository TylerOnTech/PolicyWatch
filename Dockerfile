# PolicyWatch — one image, four roles (api, worker, carrier simulator, mock receiver), selected by CMD.
#
# Targets:
#   runtime  production image: compiled JS, production dependencies only, non-root, tini as PID 1
#   tools    full dev dependencies: prisma migrations, seed and demo scripts (never exposed)
#
# For reproducible production builds, pin the base image by digest (node:22-bookworm-slim@sha256:…).

FROM node:22-bookworm-slim AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ---- all dependencies + generated Prisma client
FROM base AS deps
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund
COPY prisma ./prisma
RUN npx prisma generate

# ---- compile TypeScript
FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- tooling image (migrations, seed, demo)
FROM build AS tools
COPY openapi ./openapi
COPY scripts ./scripts
USER node
CMD ["npx", "prisma", "migrate", "deploy"]

# ---- production dependencies only
FROM base AS prod-deps
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=deps /app/node_modules/.prisma ./node_modules/.prisma

# ---- runtime
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY prisma ./prisma
COPY openapi ./openapi
COPY --from=build /app/dist ./dist
# Application files stay root-owned and read-only to the process.
USER node
EXPOSE 3000 3001
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/entrypoints/api.js"]
