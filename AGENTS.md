# Botua

Bitua's PR review agent. Modular Bun/TypeScript scripts that use Pi CLI with Kimi K2.5 to review pull requests.

## Scripts
- Each `src/*.ts` file is independently runnable via CLI args
- `src/run.ts` orchestrates them all for CI
- `extension/reviewer-tools.ts` is a Pi extension loaded during review
- `prompts/review.md` is the review system prompt

## Style
- Minimal dependencies (just bun built-ins)
- Use `parseArgs` from `util` for CLI argument parsing
- Use `fetch()` for GitHub API calls
- Print structured output to stdout, logs to stderr
- No over-engineering — simple scripts, simple piping
