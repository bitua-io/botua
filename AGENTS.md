# Botua

Bitua's PR review and automation bot. Standalone webhook service using Bun + Pi library + Kimi K2.5.

## Architecture
- `src/server.ts` — webhook entrypoint (Bun.serve on port 7800)
- `src/router.ts` — event routing, @botua mention handling, classifier dispatch
- `src/scheduler.ts` — polls SQLite queue, spawns Bun Workers, handles results
- `src/queue.ts` — SQLite job queue (jobs, events, memories tables)
- `src/classifier.ts` — persistent pi session classifying PR comments
- `src/workers/review-worker.ts` — pi agent session for PR reviews
- `src/workers/command-worker.ts` — pi agent session for interactive commands
- `src/repo-manager.ts` — git bare clones + worktrees for job isolation

## Style
- Minimal dependencies (bun built-ins + pi library)
- Use `fetch()` for GitHub/Cloudflare API calls
- Pi custom tools use `parameters` (not `inputSchema`) and return `{ content: [{ type: "text", text }], details: {} }`
- SQLite via `bun:sqlite` in WAL mode
- Workers communicate via `postMessage` with typed protocol (`src/workers/protocol.ts`)
- Tests use `bun:test`, run with `bun test`
- No over-engineering — simple scripts, simple piping

## Key patterns
- Webhook signature verification via HMAC SHA-256
- GitHub App JWT auth for installation tokens
- Git worktrees for parallel isolated workspaces per job
- Marker-based comment dedup (`<!-- botua -->`)
- PR conversation history included in review context
- Two-tier comment handling: cheap classifier → full command agent
