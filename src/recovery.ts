import type { BotuaConfig } from "./config";
import type { JobQueue } from "./queue";
import { findInstallation, getInstallationToken, updateCheckRun } from "./github";
import { existsSync, readdirSync, rmSync } from "fs";
import { join } from "path";

const ERROR_MESSAGE = "Service restart interrupted this job";

export async function recoverInterruptedJobs(
  config: BotuaConfig,
  queue: JobQueue,
): Promise<{ recovered: number; checkRunsUpdated: number; worktreesCleaned: number }> {
  const runningJobs = queue.getRunningJobs();
  let recovered = 0;
  let checkRunsUpdated = 0;

  for (const job of runningJobs) {
    queue.failJob(job.id, ERROR_MESSAGE);
    recovered++;

    const { check_run_id, head_sha } = job.payload;
    if (check_run_id && head_sha) {
      try {
        const token = await getGitHubToken(config, job.repo);
        if (token) {
          const [owner, repoName] = job.repo.split("/");
          await updateCheckRun(token, owner, repoName, check_run_id, {
            status: "completed",
            conclusion: "neutral",
            output: {
              title: "Botua — Review interrupted",
              summary:
                "The review was interrupted by a service restart. Push a new commit or comment `@botua review` to trigger a fresh review.",
            },
          });
          checkRunsUpdated++;
        }
      } catch (err: any) {
        console.error(`[recovery] failed to update check run for job ${job.id}:`, err.message);
      }
    }
  }

  const worktreesCleaned = cleanStaleWorktrees(config);

  return { recovered, checkRunsUpdated, worktreesCleaned };
}

async function getGitHubToken(config: BotuaConfig, repo: string): Promise<string | null> {
  if (config.github.app_id) {
    try {
      const [owner, repoName] = repo.split("/");
      const installationId = await findInstallation(config, owner, repoName);
      return await getInstallationToken(config, installationId);
    } catch (err: any) {
      console.error(`[recovery] failed to get installation token for ${repo}:`, err.message);
      return null;
    }
  }

  const token = process.env.GITHUB_TOKEN ?? "";
  return token || null;
}

function cleanStaleWorktrees(config: BotuaConfig): number {
  if (!existsSync(config.repos.data_dir)) return 0;

  let count = 0;
  const jobDirs = findJobDirectories(config.repos.data_dir);

  for (const dir of jobDirs) {
    rmSync(dir, { recursive: true, force: true });
    count++;
  }

  return count;
}

function findJobDirectories(root: string): string[] {
  const results: string[] = [];

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith("job-")) {
        results.push(path);
      } else {
        results.push(...findJobDirectories(path));
      }
    }
  }

  return results;
}
