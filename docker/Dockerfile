# Botua — Bitua PR Review Agent
# Lean image: bun + git only, no node/npm needed
#
# Build:
#   docker build -t gitea.bitua.io/bitua/botua:latest -f docker/Dockerfile .
#
# Run:
#   docker run --rm \
#     -e GITHUB_TOKEN=... \
#     -e KIMI_API_KEY=... \
#     -v /path/to/repo:/workspace:ro \
#     gitea.bitua.io/bitua/botua:latest \
#     --repo bitua-io/platform --pr 766 --repo-path /workspace

FROM oven/bun:1.3-alpine AS deps

WORKDIR /app
COPY package.json bun.lock ./
# Install all deps (pi-coding-agent is a dep, no global npm install needed)
RUN bun install --frozen-lockfile

# --- final image ---
FROM oven/bun:1.3-alpine

# Only git + grep + find needed for pi's built-in tools
RUN apk add --no-cache git grep findutils bash

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY AGENTS.md ./
COPY src/ ./src/
COPY extension/ ./extension/
COPY prompts/ ./prompts/

# Pi CLI via bun — no node needed
ENV PI_CMD="/app/node_modules/@mariozechner/pi-coding-agent/dist/cli.js"
RUN mkdir -p /tmp/botua-config

ENTRYPOINT ["bun", "run", "src/run.ts"]
