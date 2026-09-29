# --- build stage: full deps (incl. TypeScript), compile src/ -> dist/ ---------
FROM node:22-alpine AS build

WORKDIR /app

# Install deps first so this layer is cached unless package files change.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- runtime stage: production deps + compiled JS only, non-root -------------
FROM node:22-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# The base image ships an unprivileged "node" user; files stay root-owned
# (read-only to the process), which is all the gateway needs.
USER node

EXPOSE 3000

# Shell form so $PORT expands; busybox wget is available on alpine.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/health" >/dev/null || exit 1

# Run node directly (no npm wrapper, no tsx): one process, compiled JS only.
CMD ["node", "dist/index.js"]
