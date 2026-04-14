/**
 * Git bare clone + worktree manager.
 *
 * Layout:
 *   {data_dir}/{owner}/{name}.git           ← bare clone (shared object store)
 *   {data_dir}/{owner}/{name}-worktrees/
 *     job-{id}/                             ← detached HEAD worktree per job
 */

import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import type { BotuaConfig } from "./config";

function bareClonePath(config: BotuaConfig, repo: string): string {
  const [owner, name] = repo.split("/");
  return join(config.repos.data_dir, owner, `${name}.git`);
}

function worktreesDir(config: BotuaConfig, repo: string): string {
  const [owner, name] = repo.split("/");
  return join(config.repos.data_dir, owner, `${name}-worktrees`);
}

function worktreePath(config: BotuaConfig, repo: string, jobId: string): string {
  return join(worktreesDir(config, repo), `job-${jobId}`);
}

/**
 * Clone a repo as bare if not exists, fetch if exists.
 * @param overrideUrl — override the clone URL (for testing with file:// URLs)
 */
export async function ensureBareClone(
  config: BotuaConfig,
  repo: string,
  token?: string,
  overrideUrl?: string,
): Promise<string> {
  const barePath = bareClonePath(config, repo);

  if (!existsSync(barePath)) {
    mkdirSync(dirname(barePath), { recursive: true });

    const cloneUrl = overrideUrl ?? (token
      ? `https://x-access-token:${token}@github.com/${repo}.git`
      : `https://github.com/${repo}.git`);

    console.log(`[repo] cloning bare: ${repo} → ${barePath}`);
    const proc = Bun.spawnSync(["git", "clone", "--bare", cloneUrl, barePath], {
      stdout: "pipe",
      stderr: "pipe",
    });

    if (proc.exitCode !== 0) {
      throw new Error(`git clone --bare failed: ${proc.stderr.toString()}`);
    }

    // Remove token from stored remote URL
    if (token && !overrideUrl) {
      Bun.spawnSync(
        ["git", "remote", "set-url", "origin", `https://github.com/${repo}.git`],
        { cwd: barePath, stdout: "pipe", stderr: "pipe" },
      );
    }
  } else {
    // Fetch latest
    console.log(`[repo] fetching: ${repo}`);
    const fetchUrl = token
      ? `https://x-access-token:${token}@github.com/${repo}.git`
      : overrideUrl ?? "origin";

    Bun.spawnSync(["git", "fetch", fetchUrl, "--prune"], {
      cwd: barePath,
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  return barePath;
}

/** Create a detached worktree for a specific ref and job */
export async function createWorktree(
  config: BotuaConfig,
  repo: string,
  ref: string,
  jobId: string,
): Promise<string> {
  const barePath = bareClonePath(config, repo);
  const wtPath = worktreePath(config, repo, jobId);

  if (!existsSync(barePath)) {
    throw new Error(`Bare clone not found for ${repo}. Call ensureBareClone first.`);
  }

  mkdirSync(dirname(wtPath), { recursive: true });

  // Resolve the ref — try origin/{ref} first (normal remotes), then {ref} (bare clones from local)
  let resolvedRef = `origin/${ref}`;
  const checkRef = Bun.spawnSync(["git", "rev-parse", "--verify", resolvedRef], {
    cwd: barePath, stdout: "pipe", stderr: "pipe",
  });
  if (checkRef.exitCode !== 0) {
    resolvedRef = ref;
  }

  // Use detached HEAD to avoid branch name conflicts between concurrent jobs
  const proc = Bun.spawnSync(
    ["git", "worktree", "add", "--detach", wtPath, resolvedRef],
    { cwd: barePath, stdout: "pipe", stderr: "pipe" },
  );

  if (proc.exitCode !== 0) {
    throw new Error(`git worktree add failed: ${proc.stderr.toString()}`);
  }

  console.log(`[repo] worktree created: ${repo} @ ${ref} → ${wtPath}`);
  return wtPath;
}

/** Remove a worktree for a completed/failed job */
export async function removeWorktree(
  config: BotuaConfig,
  repo: string,
  jobId: string,
): Promise<void> {
  const barePath = bareClonePath(config, repo);
  const wtPath = worktreePath(config, repo, jobId);

  if (!existsSync(wtPath)) return;

  // git worktree remove (force to handle dirty worktrees)
  Bun.spawnSync(["git", "worktree", "remove", "--force", wtPath], {
    cwd: barePath,
    stdout: "pipe",
    stderr: "pipe",
  });

  // Fallback: if git worktree remove didn't clean the dir
  if (existsSync(wtPath)) {
    rmSync(wtPath, { recursive: true, force: true });
  }

  // Prune stale worktree refs
  Bun.spawnSync(["git", "worktree", "prune"], {
    cwd: barePath,
    stdout: "pipe",
    stderr: "pipe",
  });

  console.log(`[repo] worktree removed: ${repo} job-${jobId}`);
}

/** Fetch latest for a bare clone */
export async function fetchRepo(
  config: BotuaConfig,
  repo: string,
  token?: string,
): Promise<void> {
  await ensureBareClone(config, repo, token);
}

/** Clean up orphaned worktrees from crashes */
export async function pruneOrphanedWorktrees(config: BotuaConfig): Promise<void> {
  if (!existsSync(config.repos.data_dir)) return;

  const owners = readdirSync(config.repos.data_dir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const owner of owners) {
    const ownerDir = join(config.repos.data_dir, owner);
    const bareRepos = readdirSync(ownerDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name.endsWith(".git"))
      .map(d => d.name);

    for (const bareDir of bareRepos) {
      const barePath = join(ownerDir, bareDir);
      Bun.spawnSync(["git", "worktree", "prune"], {
        cwd: barePath,
        stdout: "pipe",
        stderr: "pipe",
      });
    }
  }
}
