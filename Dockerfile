# syntax=docker/dockerfile:1

# ---- dependencies ----------------------------------------------------------
# Installed in their own stage so the runtime image carries no lockfile, no
# pnpm store and no dev dependencies (nodemon).
FROM node:22-alpine AS deps

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
# Every dependency is pure JavaScript, so lifecycle scripts have nothing to
# build and are skipped.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# ---- runtime ---------------------------------------------------------------
FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    PORT=4000

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# The base image ships an unprivileged `node` user; nothing is written to disk
# at runtime, so read-only ownership is enough.
USER node

EXPOSE 4000

# Uses Node's built-in fetch rather than adding curl to the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# server.js installs SIGTERM/SIGINT handlers, so `docker stop` drains cleanly.
CMD ["node", "src/server.js"]
