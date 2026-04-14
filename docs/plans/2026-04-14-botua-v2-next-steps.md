# Botua v2 — Next Steps

**Date:** 2026-04-14
**Status:** v2 webhook service is live and reviewing PRs

## Current State

The v2 webhook service is running on `botua-oci` (`100.64.20.27`, port 45620), exposed at `https://botua.bitua.dev/`. GitHub App "Botua Dev" (ID 3376662) is installed on the `bitua-io` org.

### What's Working
- Bun.serve() webhook server with HMAC signature verification
- GitHub App JWT auth + installation tokens
- SQLite job queue with per-repo serialization
- Scheduler polling queue, spawning Bun Workers per job
- Pi agent sessions (kimi-coding k2p5) imported as library, not subprocess
- Git bare clone + worktree per job (fast, isolated)
- Pre-loaded file contents in prompt for speed (~2-4 min reviews)
- Check run with live progress updates (same check run, not duplicates)
- Flexible verdict parser (handles emoji headers, free-form formats)
- Review comment posted with marker-based dedup
- 42 tests passing

### Architecture
```
webhook → server → router → handler (queue job + create check run)
    → scheduler polls → bare clone + worktree
    → Bun Worker (pi library, read-only tools, custom reviewer tools)
    → verdict parsed → comment posted → check run completed → worktree cleaned
```

### Performance
| Metric | Value |
|---|---|
| Dispatch latency | 0.2s (cached repo) |
| Review time | 1.5-4 min depending on PR size |
| Uptime | stable, no crashes |
| Completed reviews | 13+ across platform and dashboard repos |

---

## TODO

### 1. Deprecate Old Workflow-Based Reviewer

The v1 reviewer runs as a GitHub Actions workflow. Now that v2 handles reviews via webhooks, the old system should be removed.

**Repos to clean up:**
- `bitua-io/platform` — delete `.github/workflows/botua-review.yml` + `packages/botua/` directory
- `bitua-io/api` — delete `.github/workflows/botua-review.yml`
- `bitua-io/botua` — delete `src/v1/` (legacy reference code)

**Steps:**
1. Create PR on `platform` removing the workflow and `packages/botua/`
2. Create PR on `api` removing the workflow
3. Delete `src/v1/` from this repo
4. Verify the GitHub App webhook continues delivering events after workflow removal
5. Remove any GitHub App secrets from the old repos' settings (BOTUA_APP_ID, BOTUA_PRIVATE_KEY) — they're now in the service config

### 2. Interactive Commands (`@botua` mentions)

The router already detects `@botua` mentions in PR/issue comments and queues `pr-command` jobs. The command worker (`src/workers/command-worker.ts`) needs implementation.

**Design (hybrid model):**
- Interactive commands use **podman containers** for safety (write access to repo)
- Build `botua-base` container image with pi CLI, git, gh, bun
- Mount the git worktree into the container
- pi runs inside container with the user's command as prompt
- Results posted as reply comment

**Steps:**
1. Create `Containerfile` for `botua-base` image
2. Build and test image on botua-oci (ARM64)
3. Implement `src/workers/command-worker.ts`
4. Add reaction (👀) on mention to acknowledge
5. Post reply comment with results
6. Push commits if pi made changes

**Example commands:**
```
@botua fix the sonarcloud issues
@botua add tests for the new endpoint
@botua explain the changes in this PR
```

### 3. Review System Prompt

The review prompt from `prompts/review.md` is not being loaded into the agent session — the agent uses its default system prompt. Loading it would improve review consistency and structure.

**Steps:**
1. Load `prompts/review.md` in the review worker
2. Pass it as context in the `session.prompt()` call (prepend to the review prompt)
3. Update the prompt to work with the pre-loaded file contents (agent doesn't need to read files itself for basic review)

### 4. Shared Memory System

The SQLite `memories` table exists but isn't being populated yet. The agent should learn from reviews and apply knowledge to future ones.

**Ideas:**
- After each review, save repo conventions discovered (linter, framework, patterns)
- On subsequent reviews, inject relevant memories into the prompt
- The `MemoryMessage` worker protocol type exists — agent just needs a `save_memory` tool
- Prune expired memories automatically (already implemented in queue)

### 5. Gitea Webhook Support

The server has a `/webhooks/gitea` endpoint and the router handles Gitea events. But Gitea webhooks aren't configured yet.

**Steps:**
1. Configure Gitea webhooks on `gitea.bitua.io/bitua/*` repos pointing to `https://botua.bitua.dev/webhooks/gitea`
2. Test with a Gitea PR
3. Handle Gitea-specific auth (Gitea API for comments/checks instead of GitHub API)

### 6. Deploy Automation

Currently deployment is manual: pull on VM, restart service. A simple deploy script or git hook would help.

**Options:**
- `scripts/deploy.sh` that SSHes to VM, pulls, restarts
- Gitea webhook on push to master → auto-deploy (botua deploys itself)
- Git credential helper on VM so `botua` user can pull without token injection

### 7. Remove Public IP (Done)

Public IP was already removed. Access via nebula (`100.64.20.27`) or cloudflare tunnel only.

### 8. Monitoring & Alerts

- Health check endpoint exists at `/health` with stats
- Add uptime monitoring (e.g., UptimeRobot, or a simple cron curl)
- Log rotation for journald
- Memory usage monitoring (4GB VM, workers use separate heaps)
- Alert on too many failed jobs

---

## Key Files

| File | Purpose |
|---|---|
| `src/server.ts` | Webhook server + health endpoint |
| `src/router.ts` | Event routing (GitHub/Gitea → handlers) |
| `src/scheduler.ts` | Job poll loop, worker lifecycle, results posting |
| `src/queue.ts` | SQLite job queue + memories |
| `src/github.ts` | GitHub App client (JWT, tokens, check runs, comments) |
| `src/workers/review-worker.ts` | Bun Worker: pi agent review session |
| `src/workers/protocol.ts` | Worker message types |
| `src/repo-manager.ts` | Git bare clone + worktree manager |
| `src/models.ts` | Pi model registry (kimi provider) |
| `src/reviewer-tools.ts` | Custom review tools (progress, PR info, base file, CI status) |
| `src/parse-verdict.ts` | Flexible verdict parser |
| `src/config.ts` | Config loader (JSON + env overrides) |
| `botua.config.json` | Service config (not in git, deployed manually) |
| `github-app.pem` | GitHub App private key (not in git) |
| `prompts/review.md` | Review system prompt |

## VM Access

```bash
ssh -p 45620 mint@100.64.20.27          # via nebula
ssh -p 45620 botua@100.64.20.27         # service user

# Service management
sudo -u botua bash -c 'XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user status botua.service'
sudo -u botua bash -c 'XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user restart botua.service'
sudo -u botua bash -c 'XDG_RUNTIME_DIR=/run/user/$(id -u) journalctl --user -u botua.service -f'

# Database
sudo sqlite3 /home/botua/botua/data/botua.db "SELECT id, repo, status, (completed_at-created_at)/1000 as secs FROM jobs ORDER BY created_at DESC LIMIT 10;"
```
