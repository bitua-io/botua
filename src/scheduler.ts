/**
 * Job scheduler — polls the queue, spawns Bun Workers, handles results.
 *
 * The scheduler runs in the main process event loop as a setInterval.
 * It tracks active workers and cleans up on completion/failure/timeout.
 */

import type { BotuaConfig } from "./config";
import type { JobQueue, Job } from "./queue";
import type { WorkerMessage } from "./workers/protocol";
import { ensureBareClone, createWorktree, removeWorktree, pruneOrphanedWorktrees } from "./repo-manager";
import { findInstallation, getInstallationToken, createCheckRun, updateCheckRun, postComment, fetchPRDiff, fetchPRComments } from "./github";
import { parseVerdict } from "./parse-verdict";
import type { ReviewVerdict } from "./types";

const COMMENT_MARKER = "<!-- botua -->";
const CHECK_NAME = "Botua";

interface ActiveWorker {
  worker: Worker;
  jobId: string;
  repo: string;
  timeout: Timer;
  payload: Record<string, any>;
  token: string;
  progressSteps: string[];
}

const activeWorkers = new Map<string, ActiveWorker>();

export function startScheduler(config: BotuaConfig, queue: JobQueue): void {
  console.log(`[scheduler] starting (poll=${config.scheduler.poll_interval_ms}ms, max_workers=${config.scheduler.max_workers})`);

  // Clean up orphaned worktrees from previous crashes
  pruneOrphanedWorktrees(config).catch(() => {});

  // Prune expired memories periodically (every 10 min)
  setInterval(() => queue.pruneExpiredMemories(), 10 * 60 * 1000);

  // Poll loop
  setInterval(() => pollQueue(config, queue), config.scheduler.poll_interval_ms);
}

export function schedulerStats() {
  return {
    active_workers: activeWorkers.size,
    worker_jobs: [...activeWorkers.values()].map(w => ({ jobId: w.jobId, repo: w.repo })),
  };
}

async function pollQueue(config: BotuaConfig, queue: JobQueue): Promise<void> {
  if (activeWorkers.size >= config.scheduler.max_workers) return;

  const job = queue.nextJob();
  if (!job) return;

  // Mark running immediately to prevent double-dispatch on next poll
  queue.startJob(job.id);

  try {
    await dispatchJob(config, queue, job);
  } catch (err: any) {
    console.error(`[scheduler] failed to dispatch job ${job.id}:`, err.message);
    queue.failJob(job.id, err.message);
  }
}

async function dispatchJob(config: BotuaConfig, queue: JobQueue, job: Job): Promise<void> {
  const [owner, repoName] = job.repo.split("/");

  // Get GitHub token
  let token: string;
  if (config.github.app_id) {
    const installationId = await findInstallation(config, owner, repoName);
    token = await getInstallationToken(config, installationId);
  } else {
    token = process.env.GITHUB_TOKEN ?? "";
  }

  // Prepare repo worktree
  const ref = job.payload.head_branch ?? "main";
  await ensureBareClone(config, job.repo, token);
  const workDir = await createWorktree(config, job.repo, ref, job.id);

  // Fetch diff and PR comments if not in payload
  if (job.payload.pr_number) {
    if (!job.payload.diff) {
      try {
        const diff = await fetchPRDiff(token, owner, repoName, job.payload.pr_number);
        job.payload.diff = diff;
      } catch (err: any) {
        console.error(`[scheduler] failed to fetch diff for ${job.repo}#${job.payload.pr_number}:`, err.message);
      }
    }
    if (!job.payload.pr_comments) {
      try {
        const comments = await fetchPRComments(token, owner, repoName, job.payload.pr_number);
        job.payload.pr_comments = comments;
      } catch (err: any) {
        console.error(`[scheduler] failed to fetch comments for ${job.repo}#${job.payload.pr_number}:`, err.message);
      }
    }
  }

  // Load memories for this repo
  const memories = queue.getMemories(job.repo).map(m => ({
    category: m.category,
    content: m.content,
  }));

  // Determine worker type and timeout
  const isReview = job.type === "pr-review";
  const workerPath = isReview
    ? new URL("./workers/review-worker.ts", import.meta.url).href
    : new URL("./workers/command-worker.ts", import.meta.url).href;
  const timeoutMs = isReview
    ? config.workers.review_timeout_ms
    : config.workers.command_timeout_ms;

  const kimiApiKey = process.env.KIMI_API_KEY ?? "";

  // Spawn worker
  const worker = new Worker(workerPath);

  const timeout = setTimeout(() => {
    console.error(`[scheduler] job ${job.id} timed out after ${timeoutMs / 1000}s`);
    worker.terminate();
    handleJobFailure(config, queue, job.id, job.repo, job.payload, token, "Job timed out");
  }, timeoutMs);

  activeWorkers.set(job.id, { worker, jobId: job.id, repo: job.repo, timeout, payload: job.payload, token, progressSteps: [] });

  // Handle messages from worker
  worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
    handleWorkerMessage(config, queue, event.data);
  };

  worker.onerror = (event: ErrorEvent) => {
    console.error(`[scheduler] worker error for job ${job.id}:`, event.message);
    handleJobFailure(config, queue, job.id, job.repo, job.payload, token, event.message);
  };

  // Send init message (job already marked running in pollQueue)
  worker.postMessage({
    type: "init",
    jobId: job.id,
    repo: job.repo,
    jobType: job.type,
    payload: job.payload,
    workDir,
    githubToken: token,
    kimiApiKey,
    config: {
      model: config.ai.model,
      provider: config.ai.provider,
      timeoutMs,
    },
    memories,
  });

  console.log(`[scheduler] dispatched job ${job.id} type=${job.type} repo=${job.repo}`);
}

async function handleWorkerMessage(config: BotuaConfig, queue: JobQueue, msg: WorkerMessage): Promise<void> {
  const active = activeWorkers.get(msg.jobId);
  if (!active) return;

  switch (msg.type) {
    case "progress":
      console.log(`[scheduler] job ${msg.jobId}: ${msg.step}`);
      active.progressSteps.push(msg.step);
      // Update check run with live progress
      updateCheckRunProgress(active).catch(() => {});
      break;

    case "complete":
      clearTimeout(active.timeout);
      activeWorkers.delete(msg.jobId);
      active.worker.terminate();

      console.log(`[scheduler] job ${msg.jobId} complete`);
      queue.completeJob(msg.jobId, msg.result);

      // Post results to GitHub
      await postResults(config, active, msg.result).catch(err => {
        console.error(`[scheduler] failed to post results for ${msg.jobId}:`, err.message);
      });

      // Clean up worktree
      removeWorktree(config, active.repo, msg.jobId).catch(() => {});
      break;

    case "error":
      clearTimeout(active.timeout);
      activeWorkers.delete(msg.jobId);
      active.worker.terminate();

      console.error(`[scheduler] job ${msg.jobId} error: ${msg.error}`);
      handleJobFailure(config, queue, msg.jobId, active.repo, active.payload, active.token, msg.error);
      break;

    case "memory":
      queue.addMemory({
        repo: msg.repo,
        category: msg.category,
        content: msg.content,
        sourceJobId: msg.jobId,
      });
      break;
  }
}

async function postResults(config: BotuaConfig, active: ActiveWorker, result: Record<string, any>): Promise<void> {
  const [owner, repoName] = active.repo.split("/");
  const { pr_number, head_sha, check_run_id } = active.payload;
  const token = active.token;
  const verdict = result.verdict as ReviewVerdict | undefined;

  if (!verdict || !pr_number) return;

  // Post review comment
  const icon = verdict.approved ? "\u2705" : "\u274C";
  const status = verdict.approved ? "Approved" : "Changes Requested";
  const commentBody = `${COMMENT_MARKER}\n## ${icon} Botua \u2014 ${status}\n\n${verdict.raw}\n\n---\n*Reviewed by Botua*`;

  await postComment(token, owner, repoName, pr_number, commentBody, COMMENT_MARKER);

  // Complete check run
  const criticalCount = verdict.issues.filter(i => i.severity === "critical").length;
  const importantCount = verdict.issues.filter(i => i.severity === "important").length;

  const conclusion = verdict.approved ? "success" : criticalCount > 0 ? "failure" : "action_required";
  const title = verdict.approved
    ? "Botua \u2014 Approved"
    : `Botua \u2014 Changes Requested (${criticalCount} critical, ${importantCount} important)`;

  if (check_run_id) {
    // Update the existing check run created by the handler
    await updateCheckRun(token, owner, repoName, check_run_id, {
      status: "completed",
      conclusion,
      output: { title, summary: verdict.summary || "" },
    });
  } else if (head_sha) {
    // Fallback: create a new check run
    await createCheckRun(token, owner, repoName, {
      name: CHECK_NAME,
      head_sha,
      status: "completed",
      conclusion,
      output: { title, summary: verdict.summary || "" },
    });
  }
}

async function updateCheckRunProgress(active: ActiveWorker): Promise<void> {
  const { token, repo, payload, progressSteps } = active;
  const checkRunId = payload.check_run_id;
  const head_sha = payload.head_sha;
  if (!token || (!checkRunId && !head_sha)) return;

  const [owner, repoName] = repo.split("/");
  const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
  const stepsText = progressSteps
    .map((s, i) => `${i === progressSteps.length - 1 ? "\u25b6" : "\u2705"} ${s}`)
    .join("\n");

  if (checkRunId) {
    await updateCheckRun(token, owner, repoName, checkRunId, {
      output: {
        title: `Botua \u2014 Reviewing... (${timestamp})`,
        summary: `**Progress:**\n${stepsText}`,
      },
    });
  }
}

async function handleJobFailure(
  config: BotuaConfig,
  queue: JobQueue,
  jobId: string,
  repo: string,
  payload: Record<string, any>,
  token: string,
  error: string,
): Promise<void> {
  const active = activeWorkers.get(jobId);
  if (active) {
    clearTimeout(active.timeout);
    active.worker.terminate();
    activeWorkers.delete(jobId);
  }

  queue.failJob(jobId, error);

  // Post failure check run
  const [owner, repoName] = repo.split("/");
  if (token) {
    try {
      if (payload.check_run_id) {
        await updateCheckRun(token, owner, repoName, payload.check_run_id, {
          status: "completed",
          conclusion: "failure",
          output: { title: "Botua \u2014 Review Failed", summary: `Error: ${error}` },
        });
      } else if (payload.head_sha) {
        await createCheckRun(token, owner, repoName, {
          name: CHECK_NAME,
          head_sha: payload.head_sha,
          status: "completed",
          conclusion: "failure",
          output: { title: "Botua \u2014 Review Failed", summary: `Error: ${error}` },
        });
      }
    } catch {}
  }

  // Clean up worktree
  removeWorktree(config, repo, jobId).catch(() => {});
}
