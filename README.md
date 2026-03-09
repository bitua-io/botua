# Botua 🤖

Bitua's PR review agent — powered by [Pi](https://github.com/niclas-niclas/pi) + Kimi K2.5.

## What it does

Botua reviews pull requests automatically when they're opened or updated. It:

1. **Fetches** the PR diff and metadata from GitHub
2. **Reviews** the code using Pi CLI with Kimi K2.5 (262K context, thinking enabled)
3. **Posts** a structured review comment on the PR
4. **Sets** a GitHub check status (✅ approved or ❌ changes requested)

The reviewer has access to tools beyond just reading the diff:
- `read` / `grep` / `find` / `ls` — explore the codebase
- `bash` — run linters, type checkers, tests
- `read_file_at_base` — see files before the PR changes
- `get_ci_status` — check if other CI checks passed
- `list_related_files` — understand blast radius

## Setup

### 1. Add the workflow to your repo

Copy `.github/workflows/botua-review.yml` to your repository.

### 2. Set secrets

| Secret | Description |
|--------|-------------|
| `KIMI_API_KEY` | Kimi Code subscription API key |
| `GITEA_REGISTRY_TOKEN` | Token to pull image from `gitea.bitua.io/bitua/botua` |

`GITHUB_TOKEN` is automatic but needs `pull-requests: write` and `checks: write` permissions.

### 3. Use self-hosted ARM64 runners

The botua Docker image is built for ARM64. The workflow expects `[self-hosted, ARM64]` runners.

## Local testing

```bash
# Fetch a PR
GITHUB_TOKEN=$(gh auth token) bun run src/fetch-pr.ts --repo bitua-io/platform --pr 766 > /tmp/pr.json

# Review it (dry run)
bun run src/run.ts --repo bitua-io/platform --pr 766 --repo-path ~/projects/api --dry-run

# Or run the full pipeline without --dry-run to post a real comment
```

## Architecture

```
src/
├── fetch-pr.ts         # GitHub API → PR metadata + diff
├── review.ts           # Pi CLI invocation with Kimi K2.5
├── parse-verdict.ts    # Parse review → structured verdict
├── comment.ts          # Post/update PR comment (idempotent)
├── check.ts            # Create/update GitHub check run
├── run.ts              # CLI orchestrator
└── types.ts            # Shared types

extension/
└── reviewer-tools.ts   # Pi extension — custom review tools

prompts/
└── review.md           # System prompt for the reviewer
```

## Built by Bitua 🐝

Name credit: Giorgio.
