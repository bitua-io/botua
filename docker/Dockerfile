# Botua — Bitua PR Review Agent
# ARM64 image for self-hosted GitHub Actions runners
#
# Build:
#   docker build -t gitea.bitua.io/bitua/botua:latest -f docker/Dockerfile .
#
# Run:
#   docker run --rm \
#     -e GITHUB_TOKEN=... \
#     -e KIMI_API_KEY=... \
#     gitea.bitua.io/bitua/botua:latest \
#     --repo bitua-io/platform --pr 766 --repo-path /workspace

FROM oven/bun:1.3-alpine AS deps

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# --- final image ---
FROM oven/bun:1.3-alpine

# Pi needs node (it's a node CLI), git for read_file_at_base tool
RUN apk add --no-cache nodejs npm git grep findutils && \
    npm install -g @mariozechner/pi-coding-agent@0.57.1 && \
    npm cache clean --force && \
    pi --version

WORKDIR /app

# Copy deps
COPY --from=deps /app/node_modules ./node_modules

# Copy source
COPY package.json ./
COPY AGENTS.md ./
COPY src/ ./src/
COPY extension/ ./extension/
COPY prompts/ ./prompts/

# Pre-create config dir for pi auth at runtime
RUN mkdir -p /tmp/botua-config

ENTRYPOINT ["bun", "run", "src/run.ts"]
