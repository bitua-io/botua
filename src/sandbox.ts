/**
 * Sandbox manager — podman container lifecycle for job execution.
 * Each job runs in an isolated container with the repo mounted.
 */

import type { BotuaConfig } from "./config";
import type { Job } from "./queue";
import { existsSync, mkdirSync } from "fs";

export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Ensure a repo is cloned and up-to-date, then checkout the right ref */
export async function ensureRepoReady(
  config: BotuaConfig,
  repo: string,
  ref?: string,
): Promise<string> {
  const [owner, name] = repo.split("/");
  const repoDir = `${config.repos.data_dir}/${owner}/${name}`;

  if (!existsSync(repoDir)) {
    // First time — clone
    mkdirSync(`${config.repos.data_dir}/${owner}`, { recursive: true });
    console.log(`[sandbox] cloning ${repo} → ${repoDir}`);

    const cloneProc = Bun.spawnSync(
      ["git", "clone", `https://github.com/${repo}.git`, repoDir],
      { stdout: "pipe", stderr: "pipe" },
    );

    if (cloneProc.exitCode !== 0) {
      throw new Error(`git clone failed: ${cloneProc.stderr.toString()}`);
    }
  } else {
    // Fetch latest
    console.log(`[sandbox] fetching ${repo}`);
    Bun.spawnSync(["git", "fetch", "origin"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
  }

  // Checkout ref if specified
  if (ref) {
    console.log(`[sandbox] checking out ${ref}`);
    Bun.spawnSync(["git", "checkout", ref], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["git", "reset", "--hard", `origin/${ref}`], {
      cwd: repoDir,
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  return repoDir;
}

/** Run a job inside a podman container */
export async function runInSandbox(
  config: BotuaConfig,
  job: Job,
  repoDir: string,
  prompt: string,
): Promise<SandboxResult> {
  const runtime = config.sandbox.runtime;
  const image = config.sandbox.image;
  const timeout = config.sandbox.job_timeout_minutes * 60 * 1000;

  const args = [
    runtime,
    "run",
    "--rm",
    "-v", `${repoDir}:/workspace:Z`,
    "-w", "/workspace",
    "-e", `BOTUA_JOB=${JSON.stringify({ id: job.id, type: job.type, repo: job.repo })}`,
  ];

  // Pass through API keys from environment
  for (const key of ["GITHUB_TOKEN", "KIMI_API_KEY", "ANTHROPIC_API_KEY"]) {
    if (process.env[key]) {
      args.push("-e", `${key}=${process.env[key]}`);
    }
  }

  args.push(image);

  // The command to run inside the container
  args.push(
    "pi",
    "-p",
    "--provider", config.ai.provider,
    "--model", config.ai.model,
    "--tools", "read,write,bash,grep,find,ls",
    "--no-skills",
    "--no-session",
    prompt,
  );

  console.log(`[sandbox] running ${runtime} container for job ${job.id}`);

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
  });

  // Set up timeout
  const timeoutId = setTimeout(() => {
    console.log(`[sandbox] job ${job.id} timed out after ${config.sandbox.job_timeout_minutes}min`);
    proc.kill();
  }, timeout);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  clearTimeout(timeoutId);

  return { exitCode, stdout, stderr };
}

/** Run a job directly on the host (no container) — for development/testing */
export async function runOnHost(
  config: BotuaConfig,
  job: Job,
  repoDir: string,
  prompt: string,
): Promise<SandboxResult> {
  const timeout = config.sandbox.job_timeout_minutes * 60 * 1000;

  const piArgs = [
    "pi",
    "-p",
    "--provider", config.ai.provider,
    "--model", config.ai.model,
    "--tools", "read,write,bash,grep,find,ls",
    "--no-skills",
    "--no-session",
    prompt,
  ];

  console.log(`[sandbox] running on host for job ${job.id} in ${repoDir}`);

  const proc = Bun.spawn(piArgs, {
    cwd: repoDir,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      BOTUA_JOB: JSON.stringify({ id: job.id, type: job.type, repo: job.repo }),
    },
  });

  const timeoutId = setTimeout(() => {
    console.log(`[sandbox] job ${job.id} timed out`);
    proc.kill();
  }, timeout);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  clearTimeout(timeoutId);

  return { exitCode, stdout, stderr };
}
