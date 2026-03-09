/**
 * CLI Orchestrator — ties fetch, review, parse, comment, and check together.
 *
 * Usage (CI):
 *   bun run src/run.ts --repo bitua-io/platform --pr 766 --repo-path /workspace
 *
 * Usage (local dry-run):
 *   bun run src/run.ts --repo bitua-io/platform --pr 766 --repo-path ~/projects/api --dry-run
 *
 * Environment:
 *   GITHUB_TOKEN — GitHub API token (required)
 *   KIMI_API_KEY — Kimi API key (required, or configured in pi auth)
 */

import { parseArgs } from "util";
import { resolve, dirname } from "path";
import type { PRInfo, ReviewVerdict } from "./types";
import { parseVerdict } from "./parse-verdict";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    repo: { type: "string" },
    pr: { type: "string" },
    "repo-path": { type: "string" },
    model: { type: "string", default: "k2p5" },
    provider: { type: "string", default: "kimi-coding" },
    "dry-run": { type: "boolean", default: false },
    "skip-check": { type: "boolean", default: false },
    verbose: { type: "boolean", default: false },
  },
  strict: true,
});

if (!values.repo || !values.pr) {
  console.error(
    "Usage: bun run src/run.ts --repo owner/repo --pr 123 --repo-path <dir> [--dry-run] [--verbose]",
  );
  process.exit(1);
}

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error("GITHUB_TOKEN env var required");
  process.exit(1);
}

const [owner, repo] = values.repo.split("/");
const prNumber = parseInt(values.pr!);
const dryRun = values["dry-run"]!;
const verbose = values.verbose!;
const projectRoot = dirname(dirname(import.meta.path));

function log(msg: string) {
  console.error(`[botua] ${msg}`);
}

// --- Step 1: Fetch PR ---
log(`Fetching PR #${prNumber} from ${owner}/${repo}...`);

const fetchProc = Bun.spawnSync(
  ["bun", "run", resolve(projectRoot, "src/fetch-pr.ts"), "--repo", values.repo!, "--pr", values.pr!],
  { env: { ...process.env, GITHUB_TOKEN: token }, stdout: "pipe", stderr: "pipe" },
);

if (fetchProc.exitCode !== 0) {
  log(`Failed to fetch PR: ${fetchProc.stderr.toString()}`);
  process.exit(1);
}

const prInfo: PRInfo = JSON.parse(fetchProc.stdout.toString());
log(`PR: "${prInfo.title}" by ${prInfo.author} (${prInfo.changedFiles.length} files changed)`);

// Write PR data for subsequent scripts
const prJsonPath = "/tmp/botua-pr-data.json";
await Bun.write(prJsonPath, JSON.stringify(prInfo));

// --- Step 2: Create in-progress check + progress comment ---
let progressCommentId: string | undefined;

if (!dryRun && !values["skip-check"]) {
  log("Creating in-progress check run...");
  Bun.spawnSync(
    [
      "bun", "run", resolve(projectRoot, "src/check.ts"),
      "--repo", values.repo!, "--sha", prInfo.headSha, "--status", "in_progress",
    ],
    { env: { ...process.env, GITHUB_TOKEN: token }, stdout: "pipe", stderr: "inherit" },
  );
}

if (!dryRun) {
  // Create a progress comment that the reviewer will update live
  log("Creating progress comment...");
  progressCommentId = await createProgressComment(
    owner, repo, prNumber, token,
  );
  if (progressCommentId) log(`Progress comment: ${progressCommentId}`);
}

// --- Step 3: Run review ---
log("Running review...");
const reviewArgs = [
  "bun", "run", resolve(projectRoot, "src/review.ts"),
  "--pr-json", prJsonPath,
  "--model", values.model!,
  "--provider", values.provider!,
];
if (values["repo-path"]) reviewArgs.push("--repo-path", resolve(values["repo-path"]));
if (verbose) reviewArgs.push("--verbose");

const reviewEnv: Record<string, string> = { ...process.env as Record<string, string> };
if (progressCommentId) {
  reviewEnv.BOTUA_PROGRESS_COMMENT_ID = progressCommentId;
  reviewEnv.BOTUA_PROGRESS_REPO = `${owner}/${repo}`;
}

const reviewProc = Bun.spawn(reviewArgs, {
  env: reviewEnv,
  stdout: "pipe",
  stderr: verbose ? "inherit" : "pipe",
});

const reviewOutput = await new Response(reviewProc.stdout).text();
const reviewExit = await reviewProc.exited;

if (reviewExit !== 0) {
  log("Review failed!");
  if (!verbose) {
    const stderr = await new Response(reviewProc.stderr).text();
    log(stderr);
  }
  // Post failure check
  if (!dryRun && !values["skip-check"]) {
    await Bun.write("/tmp/botua-error-verdict.json", JSON.stringify({
      approved: false, summary: "Review failed to complete.", strengths: [],
      issues: [{ severity: "critical", file: "", description: "Review process failed." }],
      raw: "Review failed to complete. Check CI logs for details.",
    }));
    Bun.spawnSync([
      "bun", "run", resolve(projectRoot, "src/check.ts"),
      "--repo", values.repo!, "--sha", prInfo.headSha,
      "--verdict-json", "/tmp/botua-error-verdict.json",
    ], { env: { ...process.env, GITHUB_TOKEN: token }, stderr: "inherit" });
  }
  process.exit(1);
}

log(`Review complete (${reviewOutput.length} chars)`);

// --- Step 4: Parse verdict ---
log("Parsing verdict...");
const verdict: ReviewVerdict = parseVerdict(reviewOutput);
const verdictPath = "/tmp/botua-verdict.json";
await Bun.write(verdictPath, JSON.stringify(verdict, null, 2));

const issueCount = verdict.issues.length;
const criticalCount = verdict.issues.filter((i) => i.severity === "critical").length;
log(
  `Verdict: ${verdict.approved ? "APPROVED ✅" : "CHANGES REQUESTED ❌"} (${issueCount} issues, ${criticalCount} critical)`,
);

// --- Step 5: Post comment ---
if (dryRun) {
  log("Dry run — skipping comment and check");
  log("=== Review Output ===");
  console.log(reviewOutput);
  process.exit(verdict.approved ? 0 : 1);
}

log("Posting review comment...");
const commentProc = Bun.spawnSync(
  [
    "bun", "run", resolve(projectRoot, "src/comment.ts"),
    "--repo", values.repo!, "--pr", values.pr!, "--verdict-json", verdictPath,
  ],
  { env: { ...process.env, GITHUB_TOKEN: token }, stdout: "pipe", stderr: "inherit" },
);

if (commentProc.exitCode !== 0) {
  log("Warning: failed to post comment (continuing to check)");
}

// Delete the progress comment now that the real review is posted
if (progressCommentId) {
  await deleteComment(owner, repo, progressCommentId, token);
  log("Progress comment cleaned up");
}

// --- Step 6: Complete check run ---
if (!values["skip-check"]) {
  log("Completing check run...");
  Bun.spawnSync(
    [
      "bun", "run", resolve(projectRoot, "src/check.ts"),
      "--repo", values.repo!, "--sha", prInfo.headSha, "--verdict-json", verdictPath,
    ],
    { env: { ...process.env, GITHUB_TOKEN: token }, stdout: "pipe", stderr: "inherit" },
  );
}

log("Done!");
process.exit(verdict.approved ? 0 : 1);

// --- helpers ---

async function createProgressComment(
  owner: string, repo: string, prNumber: number, token: string,
): Promise<string | undefined> {
  const body =
    `<!-- botua-progress -->\n` +
    `## 🔄 Botua — Reviewing...\n\n` +
    `- \`${new Date().toLocaleTimeString("en-US", { hour12: false })}\` Starting review...\n\n` +
    `---\n*Live progress — updates as the review runs*`;

  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`,
      {
        method: "POST",
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body }),
      },
    );
    if (!res.ok) return undefined;
    const data = await res.json();
    return String(data.id);
  } catch {
    return undefined;
  }
}

async function deleteComment(
  owner: string, repo: string, commentId: string, token: string,
): Promise<void> {
  try {
    await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/comments/${commentId}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github+json",
        },
      },
    );
  } catch {
    // best-effort cleanup
  }
}
