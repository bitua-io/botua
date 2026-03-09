# Pi PR Reviewer — Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** A modular set of Bun scripts that fetch PR diffs, run Pi code review with Kimi K2.5, post review comments, and manage GitHub check status — testable locally, deployable as a Docker image for CI.

**Architecture:** Individual scripts handle one concern each (fetch, review, comment, check). A CLI entrypoint orchestrates them for CI. The review prompt is a standalone markdown file loaded at runtime. Docker image packages everything with Pi pre-installed for the self-hosted ARM64 runners.

**Tech Stack:** Bun (TypeScript), Pi CLI (`@mariozechner/pi-coding-agent`), GitHub REST API, Docker (ARM64)

---

## Project Structure

```
~/projects/pi-reviewer/
├── package.json
├── AGENTS.md                    # Project instructions for pi itself
├── src/
│   ├── fetch-pr.ts              # Fetch PR metadata + diff
│   ├── review.ts                # Call pi with diff + prompt
│   ├── parse-verdict.ts         # Parse pi output into structured verdict
│   ├── comment.ts               # Post/update PR comment
│   ├── check.ts                 # Create/update GitHub check run
│   ├── run.ts                   # CLI orchestrator (ties everything together)
│   └── types.ts                 # Shared types
├── prompts/
│   └── review.md                # Review system prompt
├── docker/
│   └── Dockerfile               # Pi-reviewer image (ARM64)
├── .gitea/
│   └── workflows/
│       └── build-image.yml      # Build + push to gitea registry
└── docs/
    └── plans/
        └── 2026-03-09-pi-reviewer.md
```

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `AGENTS.md`
- Create: `src/types.ts`

**Step 1: Initialize project**

```bash
cd ~/projects/pi-reviewer
bun init -y
```

**Step 2: Create package.json with proper config**

```json
{
  "name": "@bitua/pi-reviewer",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "fetch": "bun run src/fetch-pr.ts",
    "review": "bun run src/review.ts",
    "comment": "bun run src/comment.ts",
    "check": "bun run src/check.ts",
    "run": "bun run src/run.ts"
  }
}
```

**Step 3: Create types.ts with shared interfaces**

```typescript
// src/types.ts
export interface PRInfo {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  diff: string;
  changedFiles: string[];
}

export interface ReviewVerdict {
  approved: boolean;
  summary: string;
  strengths: string[];
  issues: ReviewIssue[];
  raw: string;
}

export interface ReviewIssue {
  severity: "critical" | "important" | "minor";
  file: string;
  description: string;
  suggestion?: string;
}

export interface CheckResult {
  conclusion: "success" | "failure" | "action_required";
  title: string;
  summary: string;
}
```

**Step 4: Create AGENTS.md**

```markdown
# Pi Reviewer

Bun/TypeScript project. Modular scripts for PR review automation.

## Scripts
- Each `src/*.ts` file is independently runnable via CLI args
- `src/run.ts` orchestrates them all
- `prompts/review.md` is the review system prompt

## Style
- Minimal dependencies (just bun built-ins)
- Use `Bun.argv` for CLI args, `parseArgs` from `util`
- Use `fetch()` for GitHub API calls
- Print structured output to stdout, logs to stderr
```

**Step 5: Commit**

```bash
cd ~/projects/pi-reviewer
git init
git add package.json AGENTS.md src/types.ts docs/
git commit -m "init: project scaffolding with types"
```

---

### Task 2: Fetch PR Script

**Files:**
- Create: `src/fetch-pr.ts`

**Step 1: Write fetch-pr.ts**

Script that fetches PR metadata and diff from GitHub API.

CLI usage:
```bash
# Fetch PR data and output as JSON
bun run src/fetch-pr.ts --repo bitua-io/platform --pr 350

# Just the diff
bun run src/fetch-pr.ts --repo bitua-io/platform --pr 350 --diff-only
```

Implementation:
- Parse `--repo`, `--pr`, `--diff-only` from args
- Use `GITHUB_TOKEN` env var for auth
- `GET /repos/{owner}/{repo}/pulls/{number}` for metadata
- `GET /repos/{owner}/{repo}/pulls/{number}` with `Accept: application/vnd.github.diff` for diff
- `GET /repos/{owner}/{repo}/pulls/{number}/files` for changed files list
- Output `PRInfo` as JSON to stdout
- Errors/logs to stderr

**Step 2: Test locally against a real PR**

```bash
export GITHUB_TOKEN=$(gh auth token)
bun run src/fetch-pr.ts --repo bitua-io/platform --pr 350 | jq '.title, .changedFiles'
bun run src/fetch-pr.ts --repo bitua-io/platform --pr 350 --diff-only | head -50
```

**Step 3: Commit**

```bash
git add src/fetch-pr.ts
git commit -m "feat: add fetch-pr script"
```

---

### Task 3: Review Prompt

**Files:**
- Create: `prompts/review.md`

**Step 1: Write the review prompt**

The prompt file that gets fed to Pi. Should instruct the model to:
- Review the diff for bugs, security, performance, style
- Reference the repo's AGENTS.md/CLAUDE.md conventions
- Output a structured verdict section at the end
- Be constructive but honest

Key elements:
- Structured output format with clear `## Verdict` section
- `APPROVED: true/false` line for easy parsing
- Severity-categorized issues (critical/important/minor)
- File:line references
- Keep it concise — this runs on every PR

Based on the code-reviewer.md template from pi-superpowers but adapted for:
- Non-interactive (one-shot output, no back-and-forth)
- Automated parsing (structured verdict block)
- Bitua conventions (from CLAUDE.md/AGENTS.md in the repo)

**Step 2: Commit**

```bash
git add prompts/review.md
git commit -m "feat: add review prompt template"
```

---

### Task 4: Review Script (call Pi)

**Files:**
- Create: `src/review.ts`

**Step 1: Write review.ts**

Script that invokes Pi in print mode with the diff and prompt.

CLI usage:
```bash
# Review from a PR JSON (output of fetch-pr)
bun run src/review.ts --pr-json ./pr-data.json

# Review from a raw diff file
bun run src/review.ts --diff ./changes.patch --repo-path /path/to/checkout

# With custom model
bun run src/review.ts --pr-json ./pr-data.json --model kimi-k2-thinking
```

Implementation:
- Write diff to temp file
- Build pi command:
  ```
  pi -p --provider kimi-coding --model k2p5 \
    --tools read,grep,find,ls \
    --no-extensions --no-skills --no-session \
    --system-prompt "$(cat prompts/review.md)" \
    @/tmp/diff.patch \
    "Review this PR: {title}. Description: {body}"
  ```
- If `--repo-path` provided, run pi from that directory so `read` tool can access files
- Capture stdout as the review text
- Output raw review to stdout

**Step 2: Test locally**

```bash
# Get a PR, then review it
bun run src/fetch-pr.ts --repo bitua-io/platform --pr 350 > /tmp/pr.json
bun run src/review.ts --pr-json /tmp/pr.json
```

**Step 3: Commit**

```bash
git add src/review.ts
git commit -m "feat: add review script (pi invocation)"
```

---

### Task 5: Parse Verdict

**Files:**
- Create: `src/parse-verdict.ts`

**Step 1: Write parse-verdict.ts**

Parses Pi's review output into a structured `ReviewVerdict`.

CLI usage:
```bash
# Parse from stdin
cat review-output.txt | bun run src/parse-verdict.ts

# Parse from file
bun run src/parse-verdict.ts --file ./review-output.txt
```

Implementation:
- Look for `APPROVED: true` or `APPROVED: false` in the output
- Extract issues by severity (critical/important/minor sections)
- Extract strengths section
- Extract summary
- Fallback: if no structured verdict found, treat as "needs review" (action_required)
- Output `ReviewVerdict` as JSON to stdout

**Step 2: Test with sample review outputs**

Create a few sample review texts (approved, rejected, ambiguous) and verify parsing.

**Step 3: Commit**

```bash
git add src/parse-verdict.ts
git commit -m "feat: add verdict parser"
```

---

### Task 6: Comment Script

**Files:**
- Create: `src/comment.ts`

**Step 1: Write comment.ts**

Posts or updates a review comment on the PR.

CLI usage:
```bash
# Post a new comment
bun run src/comment.ts --repo bitua-io/platform --pr 350 --body "## Review\n..."

# Update existing comment (idempotent via marker)
bun run src/comment.ts --repo bitua-io/platform --pr 350 --body "## Review\n..." --update

# From stdin
cat review.md | bun run src/comment.ts --repo bitua-io/platform --pr 350 --stdin
```

Implementation:
- Use a hidden marker comment (`<!-- pi-reviewer -->`) to find existing comments
- If `--update`: find marker comment, update it. If not found, create new.
- If no `--update`: always create new comment
- Uses `GITHUB_TOKEN` for auth
- Output comment URL to stdout

**Step 2: Test locally (on a test PR or with dry-run)**

```bash
# Dry run - just print what would be posted
bun run src/comment.ts --repo bitua-io/platform --pr 350 --body "test" --dry-run
```

**Step 3: Commit**

```bash
git add src/comment.ts
git commit -m "feat: add comment script"
```

---

### Task 7: Check Script

**Files:**
- Create: `src/check.ts`

**Step 1: Write check.ts**

Creates or updates a GitHub check run on the PR's head commit.

CLI usage:
```bash
# Create a check run
bun run src/check.ts --repo bitua-io/platform --sha abc123 \
  --name "Pi Review" --status completed --conclusion success \
  --title "Review Passed" --summary "No issues found"

# Mark as in-progress
bun run src/check.ts --repo bitua-io/platform --sha abc123 \
  --name "Pi Review" --status in_progress

# From verdict JSON
cat verdict.json | bun run src/check.ts --repo bitua-io/platform --sha abc123 --from-verdict
```

Implementation:
- `POST /repos/{owner}/{repo}/check-runs` to create
- `PATCH /repos/{owner}/{repo}/check-runs/{id}` to update
- Map verdict → check conclusion:
  - approved + no critical → `success`
  - not approved or has critical → `failure`
  - parse error or ambiguous → `action_required`
- Uses `GITHUB_TOKEN` for auth

**Step 2: Test locally (dry-run)**

```bash
bun run src/check.ts --repo bitua-io/platform --sha abc123 \
  --name "Pi Review" --conclusion success --dry-run
```

**Step 3: Commit**

```bash
git add src/check.ts
git commit -m "feat: add check run script"
```

---

### Task 8: CLI Orchestrator

**Files:**
- Create: `src/run.ts`

**Step 1: Write run.ts**

The main entry point that ties all scripts together. This is what the CI workflow calls.

CLI usage:
```bash
# Full review pipeline
bun run src/run.ts --repo bitua-io/platform --pr 350

# With repo checkout (so pi can read files)
bun run src/run.ts --repo bitua-io/platform --pr 350 --repo-path ./checkout

# Dry run (no comments or checks posted)
bun run src/run.ts --repo bitua-io/platform --pr 350 --dry-run
```

Implementation — sequential pipeline:
1. `fetchPR()` → get PR data
2. Set check to `in_progress`
3. `review()` → call pi
4. `parseVerdict()` → structure the output
5. `postComment()` → post/update review comment
6. `updateCheck()` → set final check status
7. Exit 0 on success, 1 on failure

**Step 2: Test full pipeline locally**

```bash
export GITHUB_TOKEN=$(gh auth token)
export KIMI_API_KEY=sk-kimi-...
bun run src/run.ts --repo bitua-io/platform --pr 350 --dry-run
```

**Step 3: Commit**

```bash
git add src/run.ts
git commit -m "feat: add CLI orchestrator"
```

---

### Task 9: Docker Image

**Files:**
- Create: `docker/Dockerfile`

**Step 1: Write the Dockerfile**

ARM64 image with Pi, Bun, Git, and the reviewer scripts.

```dockerfile
FROM oven/bun:1-slim AS base

RUN apt-get update && apt-get install -y \
    git curl jq nodejs npm \
    && rm -rf /var/lib/apt/lists/*

# Install pi globally
RUN npm install -g @mariozechner/pi-coding-agent

# Copy reviewer scripts
WORKDIR /reviewer
COPY package.json ./
COPY src/ ./src/
COPY prompts/ ./prompts/
COPY AGENTS.md ./

# Install any bun deps
RUN bun install --production 2>/dev/null || true

ENTRYPOINT ["bun", "run", "src/run.ts"]
```

**Step 2: Test build locally**

```bash
cd ~/projects/pi-reviewer
docker build -f docker/Dockerfile -t pi-reviewer:test .
docker run --rm -e GITHUB_TOKEN -e KIMI_API_KEY \
  pi-reviewer:test --repo bitua-io/platform --pr 350 --dry-run
```

**Step 3: Commit**

```bash
git add docker/Dockerfile
git commit -m "feat: add Dockerfile (ARM64)"
```

---

### Task 10: Gitea CI Workflow

**Files:**
- Create: `.gitea/workflows/build-image.yml`

**Step 1: Write the build workflow**

Builds and pushes to `gitea.bitua.io/bitua/pi-reviewer:latest` on the ARM64 runner.

```yaml
name: Build Pi Reviewer Image

on:
  push:
    branches: [main]
    paths:
      - 'src/**'
      - 'prompts/**'
      - 'docker/**'
      - 'package.json'
  workflow_dispatch:

env:
  REGISTRY: gitea.bitua.io
  IMAGE_NAME: bitua/pi-reviewer

jobs:
  build:
    runs-on: arm64
    steps:
      - uses: actions/checkout@v4

      - uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.PACKAGE_TOKEN }}

      - uses: docker/build-push-action@v5
        with:
          context: .
          file: docker/Dockerfile
          push: true
          tags: |
            ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:latest
            ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ github.sha }}
```

**Step 2: Commit**

```bash
git add .gitea/
git commit -m "ci: add gitea workflow for image build"
```

---

### Task 11: GitHub Workflow for Platform Repo

**Files:**
- Create (in platform repo): `.github/workflows/pi-review.yml`

**Step 1: Write the review workflow**

This goes in `bitua-io/platform` and triggers on PRs.

```yaml
name: Pi Code Review

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  review:
    runs-on: [self-hosted, Linux, ARM64]
    container:
      image: gitea.bitua.io/bitua/pi-reviewer:latest
      credentials:
        username: ${{ secrets.GITEA_USER }}
        password: ${{ secrets.GITEA_TOKEN }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Run Pi Review
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          KIMI_API_KEY: ${{ secrets.KIMI_API_KEY }}
        run: |
          bun run /reviewer/src/run.ts \
            --repo ${{ github.repository }} \
            --pr ${{ github.event.pull_request.number }} \
            --repo-path ${{ github.workspace }}
```

**Step 2: This is deployed later — after local testing is complete**

---

### Task 12: End-to-End Local Test

**Step 1: Test full pipeline against a real PR**

```bash
cd ~/projects/pi-reviewer
export GITHUB_TOKEN=$(gh auth token)
export KIMI_API_KEY="sk-kimi-..."

# Pick a real PR
bun run src/run.ts --repo bitua-io/platform --pr <recent-pr> --dry-run
```

**Step 2: Review the output**

- Does the review make sense?
- Is the verdict parsing correct?
- Are the comment and check formatted well?

**Step 3: Test with actual posting (on a safe PR)**

```bash
bun run src/run.ts --repo bitua-io/platform --pr <test-pr>
```

**Step 4: Iterate on prompt and parsing based on results**

---

## Execution Order

Tasks 1-8 are the core scripts (sequential, each builds on prior).
Task 9 is the Docker image (after scripts work locally).
Task 10 is Gitea CI (after Docker works locally).
Task 11 is the GitHub workflow (final deployment).
Task 12 is E2E testing (throughout, but especially after Task 8).

## Key Environment Variables

| Variable | Source | Purpose |
|----------|--------|---------|
| `GITHUB_TOKEN` | GitHub Actions / `gh auth token` | GitHub API access |
| `KIMI_API_KEY` | Secret / `auth.json` | Pi model provider |

## Key Decisions

- **Read-only tools only** (`read,grep,find,ls`) — reviewer should never modify code
- **Kimi K2.5** via `kimi-coding` provider — Marco's subscription, 262K context
- **ARM64 only** — matches the self-hosted netcup runners
- **Idempotent comments** — uses hidden marker to update existing review comment
- **Structured verdict** — `APPROVED: true/false` for reliable parsing
