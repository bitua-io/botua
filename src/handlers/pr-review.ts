/**
 * PR Review handler — queues review jobs on PR open/sync events.
 *
 * The handler only creates a check run and queues the job.
 * The scheduler picks it up, spawns a worker, and posts results.
 */

import type { WebhookContext, RouteResult } from "../router";
import { createCheckRun, findInstallation, getInstallationToken } from "../github";

const CHECK_NAME = "Botua";

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

  // Create in-progress check run
  let checkRunId: number | undefined;
  try {
    const [owner, repoName] = repo.split("/");
    let token: string;
    if (config.github.app_id) {
      const installationId = await findInstallation(config, owner, repoName);
      token = await getInstallationToken(config, installationId);
    } else {
      token = process.env.GITHUB_TOKEN ?? "";
    }

    if (token && headSha) {
      checkRunId = await createCheckRun(token, owner, repoName, {
        name: CHECK_NAME,
        head_sha: headSha,
        status: "in_progress",
        output: { title: "Botua \u2014 Reviewing...", summary: "Review in progress." },
      });
    }
  } catch (err: any) {
    console.error(`[pr-review] failed to create check run:`, err.message);
  }

  // Queue the review job — scheduler handles everything from here
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
      check_run_id: checkRunId,
    },
  });

  return { jobId, action: "pr-review" };
}
