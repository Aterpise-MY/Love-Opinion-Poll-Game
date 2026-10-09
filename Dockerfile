# syntax=docker/dockerfile:1
#
# One image: the built frontend and the API, served by one process.
#
#   docker compose up --build
#
# No platform is pinned, here or in docker-compose.yml: the image is built on
# the laptop that runs it, for whatever architecture that laptop is.

# ---------- 1. build the SPA ----------
FROM node:22-slim AS web
WORKDIR /src

COPY package.json ./
COPY scripts/ ./scripts/
COPY content/ ./content/
COPY backend/deck.json ./backend/deck.json
COPY frontend/package.json frontend/package-lock.json ./frontend/

RUN npm ci --prefix frontend

COPY frontend/ ./frontend/

# Verify rather than regenerate: the image should contain exactly what
# `npm run content` last wrote, and a deck that has drifted from
# content/questions.source.json should fail the build loudly instead of being
# silently papered over here.
RUN node scripts/build-content.mjs --check

RUN npm run build --prefix frontend \
    # Nothing sits in front of this container to compress for it; server.js
    # serves these .gz files itself. Precompressing here is what keeps a room
    # full of phones joining over one Wi-Fi from each pulling the bundle at
    # three times the size.
 && find frontend/dist -type f \( -name '*.js' -o -name '*.css' -o -name '*.html' \) \
      -exec gzip -9 -k {} \;

# ---------- 2. backend production dependencies ----------
FROM node:22-slim AS deps
WORKDIR /src/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

# ---------- 3. runtime ----------
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app
COPY --from=deps /src/backend/node_modules ./node_modules
COPY backend/ ./
COPY --from=web /src/frontend/dist ./public

# Nothing writes to disk at runtime — votes and uploads are held in process
# memory and the static files are read-only — so running unprivileged costs
# nothing.
USER node
EXPOSE 8080

# Exec form, deliberately. Shell form makes /bin/sh PID 1, and sh does not
# forward SIGTERM: every `docker compose down` would wait out the stop timeout
# and then SIGKILL mid-request. No init process is needed — node spawns no
# children, and server.js installs its own handlers.
CMD ["node", "server.js"]
