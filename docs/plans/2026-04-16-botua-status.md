# Botua v2 — Status Update

**Date:** 2026-04-16

## Completed

### Infrastructure (2026-04-13)
- [x] Nebula VPN (`100.64.20.27`)
- [x] Cloudflared tunnel (`botua.bitua.dev`)
- [x] VM hardened (mint/botua users, port 45620, fail2ban)
- [x] OpenTofu import
- [x] Public IP removed
- [x] CF API token for DNS + tunnel management

### Core service (2026-04-14)
- [x] Webhook server (Bun.serve, signature verification)
- [x] Event router (GitHub + Gitea event handling)
- [x] SQLite job queue (WAL mode)
- [x] Scheduler (poll loop, worker lifecycle, timeouts)
- [x] Git bare clones + worktrees (parallel isolated workspaces)
- [x] Pi library integration (in-process agents, no subprocess)
- [x] Kimi K2.5 via API key auth
- [x] GitHub App "Botua Dev" (ID 3376662)
- [x] Review worker (Bun Worker, custom reviewer tools)
- [x] Check run progress (live updates during review)
- [x] Verdict parser (flexible format handling)
- [x] 42 tests across 7 files

### Deprecation (2026-04-14)
- [x] Removed `botua-review.yml` from platform + api-elis (+ dev branch)
- [x] Removed `packages/botua/` from platform monorepo
- [x] Removed `src/v1/` legacy scripts
- [x] Deleted org secrets `BOTUA_APP_ID`, `BOTUA_PRIVATE_KEY`

### Improvements (2026-04-15–16)
- [x] Dedup reviews by HEAD sha (skip already-reviewed commits)
- [x] `@botua review` to force re-review
- [x] PR conversation context in reviews (previous reviews + user replies)
- [x] Parallel workers (3 concurrent, no per-repo serialization)
- [x] Bare clone refspec fix (`+refs/heads/*:refs/remotes/origin/*`)
- [x] Classifier worker (persistent pi session, classifies PR comments)
- [x] Command worker (creates issues, updates checks, comments on PRs)
- [x] Quote stripping for comment parsing
- [x] 74 tests across 10 files

## In Progress

### Review system prompt
- [ ] Load `prompts/review.md` into review worker session
- [ ] Tune prompt for pre-loaded file contents

### Command worker polish
- [ ] Improve issue creation quality (more context from review)
- [ ] Test `@botua` interaction flows end-to-end
- [ ] Handle edge cases (classifier timeouts, model refusals)

## Remaining

### Gitea webhooks
- [ ] Configure webhooks on `gitea.bitua.io/bitua/*` repos
- [ ] Handle Gitea-specific API (comments, checks)
- [ ] Test with a Gitea PR

### Podman sandbox (interactive commands)
- [ ] Create `botua-base` container image
- [ ] `@botua fix this` with write access in container
- [ ] Push commits from container back to PR branch

### Monitoring
- [ ] Uptime check on `botua.bitua.dev/health`
- [ ] Alert on consecutive failures
- [ ] Metrics dashboard (review times, success rates)

### Deploy automation
- [ ] Auto-deploy on push to master (git pull + restart)
- [ ] Or: Gitea Actions workflow on botua repo
