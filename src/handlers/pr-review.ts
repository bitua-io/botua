/**
 * PR Review handler — automated code review triggered by PR open/sync events.
 *
 * Flow:
 * 1. Extract PR info from webhook payload
 * 2. Queue a review job
 * 3. Worker picks it up → run pi in sandbox → parse verdict → post results
 */

import type { WebhookContext, RouteResult } from "../router";
import type { Job } from "../queue";
import type { BotuaConfig } from "../config";
import type { ReviewVerdict } from "../types";
import { parseVerdict } from "../parse-verdict";
import { ensureRepoReady, runInSandbox, runOnHost } from "../sandbox";
import {
  getInstallationToken,
  findInstallation,
  createCheckRun,
  postComment,
  fetchPRDiff,
} from "../github";

const COMMENT_MARKER = "<!-- botua -->";
const CHECK_NAME = "Botua";

/** Called by the router when a PR is opened or updated */
export async function handlePRReview(ctx: WebhookContext): Promise<RouteResult> {
  const { payload, queue, config } = ctx;

  const repo = payload.repository?.full_name;
  const pr = payload.pull_request;

  if (!repo || !pr) {
    return { skipped: "missing repo or PR data" };
  }

  const prNumber = pr.number;
  const headSha = pr.head?.sha;
  const headBranch = pr.head?.ref;
  const baseBranch = pr.base?.ref;
  const title = pr.title;
  const body = pr.body ?? "";
  const author = pr.user?.login;

  console.log(`[pr-review] ${repo}#${prNumber} "${title}" by ${author}`);

  // Queue the review job
  const jobId = queue.createJob({
    repo,
    type: "pr-review",
    payload: {
      pr_number: prNumber,
      head_sha: headSha,
      head_branch: headBranch,
      base_branch: baseBranch,
      title,
      body,
      author,
    },
  });

  // Process the job asynchronously (don't block the webhook response)
  processReviewJob(jobId, config, queue).catch(err => {
    console.error(`[pr-review] job ${jobId} failed:`, err);
    queue.failJob(jobId, err.message);
  });

  return { jobId, action: "pr-review" };
}

/** Process a review job — runs async after the webhook returns */
async function processReviewJob(jobId: string, config: BotuaConfig, queue: any): Promise<void> {
  const job = queue.getJob(jobId) as Job;
  if (!job) throw new Error(`job ${jobId} not found`);

  const { repo, payload } = job;
  const [owner, repoName] = repo.split("/");
  const { pr_number, head_sha, head_branch, title, body } = payload;

  queue.startJob(jobId);

  // Get GitHub token
  let token: string;
  if (config.github.app_id) {
    const installationId = await findInstallation(config, owner, repoName);
    token = await getInstallationToken(config, installationId);
  } else {
    // Fallback to env var (for development)
    token = process.env.GITHUB_TOKEN ?? "";
    if (!token) {
      throw new Error("No GitHub token available (no app configured, no GITHUB_TOKEN env)");
    }
  }

  // Create in-progress check run
  let checkRunId: number | undefined;
  try {
    checkRunId = await createCheckRun(token, owner, repoName, {
      name: CHECK_NAME,
      head_sha,
      status: "in_progress",
      output: { title: "Botua — Reviewing...", summary: "Review in progress." },
    });
  } catch (err) {
    console.error(`[pr-review] failed to create check run:`, err);
  }

  try {
    // Prepare repo (use installation token for clone/fetch auth)
    const repoDir = await ensureRepoReady(config, repo, head_branch, token);

    // Fetch the PR diff
    const diff = await fetchPRDiff(token, owner, repoName, pr_number);

    // Build the review prompt
    const prompt = buildReviewPrompt(title, body, diff);

    // Run the review
    const result = await runOnHost(config, job, repoDir, prompt);

    if (result.exitCode !== 0) {
      throw new Error(`Review process exited with code ${result.exitCode}: ${result.stderr}`);
    }

    // Parse the verdict
    const verdict = parseVerdict(result.stdout);

    console.log(
      `[pr-review] ${repo}#${pr_number}: ${verdict.approved ? "APPROVED" : "CHANGES REQUESTED"} ` +
      `(${verdict.issues.length} issues)`,
    );

    // Post review comment
    const commentBody = formatReviewComment(verdict);
    await postComment(token, owner, repoName, pr_number, commentBody, COMMENT_MARKER);

    // Complete check run
    if (checkRunId) {
      const checkResult = verdictToCheck(verdict);
      await createCheckRun(token, owner, repoName, {
        name: CHECK_NAME,
        head_sha,
        status: "completed",
        conclusion: checkResult.conclusion,
        output: { title: checkResult.title, summary: checkResult.summary },
      });
    }

    queue.completeJob(jobId, {
      approved: verdict.approved,
      issues: verdict.issues.length,
      critical: verdict.issues.filter(i => i.severity === "critical").length,
    });
  } catch (err: any) {
    console.error(`[pr-review] job ${jobId} error:`, err);

    // Post failure check
    if (checkRunId) {
      try {
        await createCheckRun(token, owner, repoName, {
          name: CHECK_NAME,
          head_sha,
          status: "completed",
          conclusion: "failure",
          output: {
            title: "Botua — Review Failed",
            summary: `Review failed: ${err.message}`,
          },
        });
      } catch {}
    }

    queue.failJob(jobId, err.message);
  }
}

function buildReviewPrompt(title: string, body: string, diff: string): string {
  return [
    "Review this pull request.",
    "",
    `Title: ${title}`,
    `Description: ${body || "(no description)"}`,
    "",
    "Diff:",
    "```diff",
    diff,
    "```",
  ].join("\n");
}

function formatReviewComment(verdict: ReviewVerdict): string {
  const icon = verdict.approved ? "\u2705" : "\u274C";
  const status = verdict.approved ? "Approved" : "Changes Requested";

  let md = `${COMMENT_MARKER}\n`;
  md += `## ${icon} Botua \u2014 ${status}\n\n`;
  md += verdict.raw;
  md += `\n\n---\n*Reviewed by Botua*`;

  return md;
}

function verdictToCheck(verdict: ReviewVerdict) {
  const criticalCount = verdict.issues.filter(i => i.severity === "critical").length;
  const importantCount = verdict.issues.filter(i => i.severity === "important").length;

  let conclusion: "success" | "failure" | "action_required";
  if (verdict.approved) {
    conclusion = "success";
  } else if (criticalCount > 0) {
    conclusion = "failure";
  } else {
    conclusion = "action_required";
  }

  const title = verdict.approved
    ? "Botua \u2014 Approved"
    : `Botua \u2014 Changes Requested (${criticalCount} critical, ${importantCount} important)`;

  let summary = verdict.summary + "\n\n";
  if (verdict.issues.length > 0) {
    summary += `**Issues:** ${criticalCount} critical, ${importantCount} important, ` +
      `${verdict.issues.length - criticalCount - importantCount} minor\n\n`;
    for (const issue of verdict.issues.filter(i => i.severity !== "minor")) {
      summary += `- **[${issue.severity}]** ${issue.file ? `\`${issue.file}\`: ` : ""}${issue.description.split("\n")[0]}\n`;
    }
  }

  return { conclusion, title, summary };
}
