# Botua 🤖

Bitua's PR review and automation bot — a standalone webhook service powered by [Pi](https://github.com/badlogic/pi-mono) + Kimi K2.5.

## What it does

Botua is a GitHub App installed on the `bitua-io` org. It receives webhooks and:

1. **Reviews PRs** automatically on open/push — reads the diff, explores the codebase, runs tests, and posts a structured review with a check run
2. **Listens to discussions** — classifies PR comments to detect when devs acknowledge findings, ask questions, or request actions
3. **Takes action** — creates follow-up issues, updates check runs, and replies on PRs when asked

No per-repo workflow needed. The GitHub App handles everything via webhooks.

## Architecture

```
                    Cloudflare Tunnel
                    botua.bitua.dev
                         │
                    ┌────▼────┐
                    │ Webhook  │  Bun.serve() on port 7800
                    │ Server   │  Signature verification
                    └────┬────┘
                         │
                    ┌────▼────┐
                    │ Router   │  Event → handler mapping
                    └────┬────┘
                         │
              ┌──────────┼──────────┐
              │          │          │
        ┌─────▼─────┐   │   ┌─────▼──────┐
        │ PR Review │   │   │ Classifier  │  Persistent pi session
        │ Handler   │   │   │ Worker      │  Detects relevant comments
        └─────┬─────┘   │   └─────┬──────┘
              │          │         │
              ▼          │         ▼
        ┌──────────┐     │   ┌──────────┐
        │ SQLite   │◄────┘   │ Command  │  Creates issues, updates
        │ Job Queue│         │ Worker   │  checks, comments on PRs
        └────┬─────┘         └──────────┘
             │
        ┌────▼─────┐
        │Scheduler │  Polls queue, spawns Bun Workers
        └────┬─────┘
             │
     ┌───────┼───────┐
     ▼       ▼       ▼
  ┌──────┐┌──────┐┌──────┐
  │Review││Review││Review│  Up to 3 parallel workers
  │Worker││Worker││Worker│  Pi library in-process
  └──────┘└──────┘└──────┘  Git worktrees for isolation
```

## Source layout

```
src/
├── server.ts                  # Webhook server (Bun.serve)
├── router.ts                  # Event routing + @botua mention handling
├── scheduler.ts               # Job poll loop + worker lifecycle
├── queue.ts                   # SQLite job queue + memories
├── config.ts                  # Config loading + defaults
├── github.ts                  # GitHub App auth (JWT), check runs, comments
├── classifier.ts              # Persistent pi session for comment classification
├── repo-manager.ts            # Git bare clones + worktrees
├── models.ts                  # Pi model registry + kimi provider setup
├── reviewer-tools.ts          # Custom review tools (library mode)
├── parse-verdict.ts           # Review output → structured verdict
├── types.ts                   # Shared types
├── handlers/
│   └── pr-review.ts           # PR open/push → queue review job
└── workers/
    ├── protocol.ts            # Worker ↔ main message types
    ├── review-worker.ts       # Bun Worker: pi agent review session
    └── command-worker.ts      # Bun Worker: pi agent for @botua commands
```

## Infrastructure

| Component | Details |
|-----------|---------|
| VM | `botua-oci` — ARM64, 2 OCPU, 4GB RAM, Debian 13 |
| Network | Nebula VPN `100.64.20.27`, SSH port `45620` |
| Tunnel | Cloudflare tunnel → `botua.bitua.dev` |
| Service | systemd user service under `botua` user |
| GitHub App | "Botua Dev" (ID 3376662), installed on `bitua-io` org |
| AI Model | Kimi K2.5 via API (`api.kimi.com/coding/`) |
| Database | SQLite (WAL mode) at `data/botua.db` |

## Interacting with Botua

### Automatic reviews
Every PR opened or pushed to on any `bitua-io` repo gets reviewed automatically. Botua posts a review comment and sets a check run.

### @botua commands
Comment on a PR with `@botua` to interact:

| Command | Effect |
|---------|--------|
| `@botua review` | Force a re-review (even if already reviewed) |
| `@botua <request>` | Ask botua to do something (create issue, update check, etc.) |

### Natural discussion
Botua listens to all comments on PRs it has reviewed. No need to tag — just discuss the review findings naturally. If the comment is relevant (acknowledging a finding, asking a question, requesting an action), botua will react and may respond.

## Development

```bash
# Install deps
bun install

# Run locally
bun run start

# Run tests
bun test
```

## Built by Bitua 🤖

Name credit: Giorgio.
