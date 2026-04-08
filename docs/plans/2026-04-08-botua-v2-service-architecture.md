# Botua v2 — Service Architecture Design

**Date:** 2026-04-08
**Status:** Draft
**Authors:** Marco Torres, memu

## Goal

Transform Botua from a GitHub Actions workflow into a standalone, webhook-driven service — the central dev automation bot for Bitua. Like SonarCloud: install the GitHub App on the org and it just works across all repos. No per-repo workflow files, no runner dependencies, no secrets to copy.

## MVP Scope

1. **Automated PR review** — webhook-triggered, replaces the current `botua-review.yml` workflow
2. **Interactive commands** — `@botua` mentions in PR comments and issues trigger actions (fix code, push commits, run checks)

Notification routing (GitHub/Gitea/Dokploy → Google Chat) is deferred to v2.1.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Botua Service (Bun)                       │
│                                                             │
│  Bun.serve()                                                │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐                 │
│  │  GitHub   │  │  Gitea   │  │  Health/  │                 │
│  │ Webhooks  │  │ Webhooks │  │  Status   │                 │
│  └─────┬─────┘  └────┬─────┘  └───────────┘                 │
│        └──────────────┤                                     │
│                       ▼                                     │
│              ┌────────────────┐                              │
│              │  Event Router  │                              │
│              └───────┬────────┘                              │
│           ┌──────────┼──────────┐                           │
│           ▼          ▼          ▼                           │
│     ┌──────────┐ ┌──────────┐ ┌──────────┐                 │
│     │ PR Review│ │ PR/Issue │ │ Repo     │                 │
│     │ (auto)   │ │ Command  │ │ Sync     │                 │
│     └─────┬────┘ └─────┬────┘ └──────────┘                 │
│           └─────────────┤                                   │
│                         ▼                                   │
│              ┌────────────────┐       ┌──────────────┐      │
│              │  Job Queue     │──────▶│   Sandbox    │      │
│              │  (bun:sqlite)  │       │  (podman)    │      │
│              └────────────────┘       └──────┬───────┘      │
│                                              │              │
│                                     ┌────────▼────────┐     │
│                                     │  pi subprocess  │     │
│                                     │  + tools/exts   │     │
│                                     └─────────────────┘     │
│                                                             │
│  repos/                                                     │
│  ├── bitua-io/platform/    (pre-cloned, git fetch per job)  │
│  ├── bitua-io/botua/                                        │
│  └── bitua-io/*/                                            │
└─────────────────────────────────────────────────────────────┘
```

### Core Principles

- **Bun-native**: `Bun.serve()` for HTTP, `bun:sqlite` for state, `Bun.spawn()` for subprocesses. Minimal external deps.
- **Pi subprocess in containers**: each job runs pi inside a podman container with the repo mounted. Full tool ecosystem, sandbox isolation.
- **Pre-cloned repos**: like a dev workstation — repos are pre-cloned, `git fetch + checkout` per job instead of full clone.
- **Podman (rootless)**: userspace containers, no daemon, fast startup. Each job gets an isolated filesystem.

---

## Tech Stack

### Service (host)

```
bun native (zero deps):
├── Bun.serve()        → webhook receiver + health endpoint
├── bun:sqlite         → job queue, event log, repo registry
├── Bun.spawn()        → podman lifecycle + git operations
├── fetch()            → GitHub/Gitea API (check runs, comments, push)
└── Bun.file()         → config, logs

external deps (minimal):
└── yaml               → config parsing (could use JSON to eliminate this too)

system deps:
├── bun                → runtime
├── podman             → container runtime (rootless)
└── git                → repo sync (on host, for pre-clone management)
```

### Container (botua-base image)

Pre-built image with everything a "dev workstation" needs:

```Containerfile
FROM oven/bun:latest

# Dev tools
RUN apt-get update && apt-get install -y git curl jq

# Pi CLI
RUN bun install -g @mariozechner/pi-coding-agent

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh

# Botua tools (pi extensions)
COPY tools/ /opt/botua/tools/
```

Tools available inside the container:
- **pi CLI** — the AI agent with full tool-use (read, write, bash, grep, etc.)
- **gh CLI** — GitHub operations (push, PR comments, check runs)
- **git** — branch management, commits, push
- **Custom pi extensions** — SonarCloud, Gitea, deployment checks

---

## Components

### 1. Webhook Server (`src/server.ts`)

```typescript
Bun.serve({
  port: Bun.env.PORT ?? 7800,

  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/webhooks/github") {
      // Verify webhook signature (HMAC SHA-256)
      // Parse event type from X-GitHub-Event header
      // Route to handler
    }

    if (url.pathname === "/webhooks/gitea") {
      // Similar for Gitea webhooks
    }

    if (url.pathname === "/health") {
      return Response.json({ status: "ok", jobs: queue.stats() });
    }

    return new Response("Not Found", { status: 404 });
  },
});
```

Webhook signature verification is just `crypto.createHmac('sha256', secret)` — no library needed.

### 2. Event Router (`src/router.ts`)

Maps webhook events to handlers:

| Event | Trigger | Handler |
|---|---|---|
| `pull_request.opened` | PR opened | `pr-review` (automated) |
| `pull_request.synchronize` | PR updated (new commits) | `pr-review` (automated) |
| `issue_comment.created` | Comment with `@botua` | `pr-command` or `issue-command` |
| `pull_request_review_comment.created` | Review comment with `@botua` | `pr-command` |

The router extracts:
- **repo**: which repo the event is for
- **ref**: branch/PR to work on
- **command**: what to do (auto-review, or parsed from @mention)
- **context**: PR diff, issue body, comment text

### 3. Job Queue (`src/queue.ts`)

SQLite-backed job queue with concurrency control:

```sql
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,          -- uuidv7
  repo TEXT NOT NULL,            -- "bitua-io/platform"
  type TEXT NOT NULL,            -- "pr-review" | "pr-command" | "issue-command"
  status TEXT DEFAULT 'queued',  -- queued | running | complete | failed
  payload TEXT NOT NULL,         -- JSON (PR info, command, context)
  result TEXT,                   -- JSON (review verdict, commit SHA, etc.)
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  container_id TEXT              -- podman container ID while running
);

CREATE TABLE repos (
  name TEXT PRIMARY KEY,         -- "bitua-io/platform"
  clone_path TEXT NOT NULL,      -- "/data/repos/bitua-io/platform"
  last_synced INTEGER,
  config TEXT                    -- JSON (.botua.yml contents, cached)
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,           -- "github" | "gitea"
  event_type TEXT NOT NULL,       -- "pull_request.opened" etc.
  repo TEXT NOT NULL,
  payload TEXT NOT NULL,          -- raw webhook payload
  job_id TEXT,                    -- linked job (if one was created)
  received_at INTEGER NOT NULL
);
```

Concurrency: configurable max concurrent jobs (default 2). Jobs for the same repo serialize to avoid git conflicts.

### 4. Sandbox Manager (`src/sandbox.ts`)

Manages podman container lifecycle per job:

```typescript
async function runJob(job: Job): Promise<JobResult> {
  const repoPath = await ensureRepoReady(job.repo, job.ref);

  // Start container with repo mounted
  const container = await podman.run({
    image: "botua-base:latest",
    volumes: [`${repoPath}:/workspace:Z`],
    env: {
      GITHUB_TOKEN: getInstallationToken(job.repo),
      PI_MODEL: config.model ?? "kimi/kimi-k2-0520",
      BOTUA_JOB: JSON.stringify(job),
    },
    workdir: "/workspace",
    rm: true,  // auto-remove on exit
  });

  // Run pi with the appropriate prompt + extensions
  const result = await container.exec([
    "pi",
    "--prompt", buildPrompt(job),
    "--tools", "read,write,bash,grep,find,ls",
    "--extensions", "/opt/botua/tools/",
    "--max-turns", "50",
  ]);

  return parseResult(result);
}
```

`ensureRepoReady()`:
1. If repo not cloned: `git clone` into `/data/repos/<owner>/<name>/`
2. If cloned: `git fetch origin`
3. `git checkout` the PR branch or create a worktree

### 5. GitHub App Client (`src/github.ts`)

Handles GitHub App authentication and API operations:

- **Installation tokens**: JWT → installation token per repo (auto-refreshed)
- **Check runs**: create/update check status on PRs
- **Comments**: post review comments, reply to @mentions
- **Push**: commits are pushed from inside the container using the installation token

### 6. Handlers

#### `handlers/pr-review.ts` — Automated Review

Triggered on `pull_request.opened` and `pull_request.synchronize`:

1. Create check run (status: in_progress)
2. Queue job with PR context (diff, files, metadata)
3. Job runs: pi reviews the code using AGENTS.md + tools
4. Post review comment on PR
5. Complete check run (approved / changes requested)

Same logic as current botua, just decoupled from GitHub Actions.

#### `handlers/pr-command.ts` — Interactive Commands

Triggered on `issue_comment.created` with `@botua` mention:

1. Parse command from comment text
2. React with 👀 emoji (acknowledge)
3. Queue job with command + PR context
4. Job runs: pi executes in the repo with the command as prompt
5. Pi can: read files, write fixes, run tests, commit, push
6. Reply to the comment with summary of what was done

Example commands:
```
@botua fix the sonarcloud issues
@botua add tests for the new endpoint
@botua rebase on dev
@botua explain the changes in this PR
```

#### `handlers/repo-sync.ts` — Keep Repos Fresh

Background task (cron or on-demand):
- `git fetch` all registered repos periodically
- Update cached `.botua.yml` config
- Prune old branches/worktrees

---

## Configuration

### Global config (`botua.config.yaml`)

```yaml
server:
  port: 7800
  host: 0.0.0.0

github:
  app_id: 12345
  private_key_path: /etc/botua/github-app.pem
  webhook_secret: "hmac-secret"

sandbox:
  runtime: podman
  image: botua-base:latest
  max_concurrent_jobs: 2
  job_timeout_minutes: 25

ai:
  model: kimi/kimi-k2-0520
  api_key_env: KIMI_API_KEY

repos:
  data_dir: /data/repos

# per-repo overrides (merged with .botua.yml in repo)
repo_overrides:
  bitua-io/platform:
    auto_review: true
    interactive: true
  bitua-io/infra:
    auto_review: false
    interactive: true
```

### Per-repo config (`.botua.yml` in repo root)

```yaml
# Existing format, already in use
ignore:
  - "infra/containers/**/flows.json"
  - "**/*.lock"

# New fields for v2
review:
  enabled: true
  model: kimi/kimi-k2-0520    # override default model

interactive:
  enabled: true
  allowed_commands:
    - review
    - fix
    - test
    - explain
    - rebase
```

---

## Deployment

### VM Setup (OCI Free Tier)

```
botua-oci (Oracle Cloud — ARM64 Ampere, 4 OCPU, 24GB RAM)
├── bun (runtime)
├── podman (rootless containers)
├── git
├── /data/repos/         → pre-cloned repos
├── /data/botua.db       → SQLite state
├── /etc/botua/          → config + GitHub App private key
└── systemd service: botua.service
```

### Networking

- **Inbound**: HTTPS on port 443 (Caddy/Cloudflare tunnel → localhost:7800)
- **Domain**: `botua.bitua.dev` or `botua.internal.bitua.io` (Nebula)
- **GitHub webhooks**: point to `https://botua.bitua.dev/webhooks/github`
- **Gitea webhooks**: point to `https://botua.bitua.dev/webhooks/gitea` (or via Nebula internal)

### GitHub App Setup

1. Create GitHub App at `github.com/organizations/bitua-io/settings/apps`
2. Permissions:
   - `contents: write` (push commits)
   - `pull_requests: write` (comments, reviews)
   - `checks: write` (check runs)
   - `issues: write` (comment on issues)
   - `metadata: read` (repo info)
3. Subscribe to events: `pull_request`, `issue_comment`, `pull_request_review_comment`
4. Webhook URL: `https://botua.bitua.dev/webhooks/github`
5. Install on `bitua-io` org (all repos or selected)

### Container Image

Build and push `botua-base` to Gitea registry:

```bash
podman build -t gitea.bitua.io/bitua/botua-base:latest -f Containerfile .
podman push gitea.bitua.io/bitua/botua-base:latest
```

---

## Migration Path

| Phase | What | Where |
|---|---|---|
| 1 | Build botua service in `bitua-io/botua` repo | This repo |
| 2 | Deploy to OCI VM, configure GitHub App | botua-oci |
| 3 | Test alongside existing `botua-review.yml` workflow | Both running |
| 4 | Disable workflow, botua service handles all reviews | Service only |
| 5 | Remove `packages/botua/` and `botua-review.yml` from platform | Cleanup |

During phase 3, both systems run in parallel. The workflow can be disabled per-repo by removing it, while the service picks up via webhooks.

---

## Future (v2.1+)

- **Notification routing**: GitHub/Gitea/Dokploy events → Google Chat (filtered, formatted)
- **Scheduled tasks**: daily standup summaries, stale PR reminders
- **Multi-model**: different AI models per task type (review vs fix vs explain)
- **Dashboard**: simple web UI showing job history, stats, logs
- **Gitea webhook support**: reviews on Gitea PRs too (for mirrored repos)

---

## References

- [pi-mom](https://github.com/badlogic/pi-mono/tree/main/packages/mom) — Slack bot, pi subprocess, Docker sandbox
- [mercury](https://github.com/Michaelliv/mercury) — multi-channel bot, pi subprocess, SQLite, extensions
- [nanoclaw](https://github.com/qwibitai/nanoclaw) — container isolation per conversation, Claude SDK
- [pi-channels](https://github.com/aktech/pi-channels) — event-driven, MCP channel servers
- [pi-telegram](https://github.com/badlogic/pi-telegram) — Telegram DM bridge for pi
