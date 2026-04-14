import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  ensureBareClone,
  createWorktree,
  removeWorktree,
  pruneOrphanedWorktrees,
} from "../src/repo-manager";
import type { BotuaConfig } from "../src/config";

// Create a temp git repo to act as "remote"
let tempDir: string;
let remoteRepo: string;
let config: BotuaConfig;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "botua-test-"));
  remoteRepo = join(tempDir, "remote.git");

  // Create a bare remote repo with a commit
  const srcRepo = join(tempDir, "src-repo");
  Bun.spawnSync(["git", "init", srcRepo], { stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: srcRepo, stdout: "pipe" });
  Bun.spawnSync(["git", "config", "user.name", "test"], { cwd: srcRepo, stdout: "pipe" });
  Bun.spawnSync(["git", "checkout", "-b", "main"], { cwd: srcRepo, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["bash", "-c", "echo 'hello' > file.txt && git add . && git commit -m 'init'"], {
    cwd: srcRepo, stdout: "pipe", stderr: "pipe",
  });
  // Create a feature branch
  Bun.spawnSync(["bash", "-c", "git checkout -b feat/test && echo 'world' >> file.txt && git add . && git commit -m 'feat'"], {
    cwd: srcRepo, stdout: "pipe", stderr: "pipe",
  });
  Bun.spawnSync(["git", "checkout", "main"], { cwd: srcRepo, stdout: "pipe", stderr: "pipe" });
  // Make it bare
  Bun.spawnSync(["git", "clone", "--bare", srcRepo, remoteRepo], { stdout: "pipe", stderr: "pipe" });

  config = {
    repos: { data_dir: join(tempDir, "repos") },
  } as BotuaConfig;
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("repo-manager", () => {
  test("ensureBareClone clones a repo as bare", async () => {
    // Use local file:// URL as the "remote"
    const clonePath = await ensureBareClone(config, "test-org/test-repo", undefined, remoteRepo);
    expect(existsSync(clonePath)).toBe(true);
    expect(clonePath).toEndWith("test-repo.git");
    // Verify it's bare
    const result = Bun.spawnSync(["git", "rev-parse", "--is-bare-repository"], {
      cwd: clonePath, stdout: "pipe",
    });
    expect(result.stdout.toString().trim()).toBe("true");
  });

  test("ensureBareClone fetches if already cloned", async () => {
    // Should not throw, just fetch
    const clonePath = await ensureBareClone(config, "test-org/test-repo", undefined, remoteRepo);
    expect(existsSync(clonePath)).toBe(true);
  });

  test("createWorktree creates a worktree at the correct ref", async () => {
    const worktreePath = await createWorktree(config, "test-org/test-repo", "feat/test", "job-001");
    expect(existsSync(worktreePath)).toBe(true);
    expect(worktreePath).toContain("job-001");

    // Check that the worktree has the right content
    const content = await Bun.file(join(worktreePath, "file.txt")).text();
    expect(content.trim()).toBe("hello\nworld");
  });

  test("createWorktree for main branch", async () => {
    const worktreePath = await createWorktree(config, "test-org/test-repo", "main", "job-002");
    expect(existsSync(worktreePath)).toBe(true);

    const content = await Bun.file(join(worktreePath, "file.txt")).text();
    expect(content.trim()).toBe("hello");
  });

  test("removeWorktree cleans up", async () => {
    const worktreePath = await createWorktree(config, "test-org/test-repo", "main", "job-003");
    expect(existsSync(worktreePath)).toBe(true);

    await removeWorktree(config, "test-org/test-repo", "job-003");
    expect(existsSync(worktreePath)).toBe(false);
  });

  test("pruneOrphanedWorktrees removes stale worktrees", async () => {
    // Create a worktree then manually remove its lock file to simulate orphan
    const wt = await createWorktree(config, "test-org/test-repo", "main", "job-orphan");
    expect(existsSync(wt)).toBe(true);

    // Prune should clean up worktrees (git worktree prune)
    await pruneOrphanedWorktrees(config);
    // The worktree still exists (not orphaned since dir exists)
    // But if we remove the dir manually, prune should clean the git ref
    rmSync(wt, { recursive: true, force: true });
    await pruneOrphanedWorktrees(config);
  });

  test("concurrent worktrees on same repo work", async () => {
    const wt1 = await createWorktree(config, "test-org/test-repo", "main", "job-c1");
    const wt2 = await createWorktree(config, "test-org/test-repo", "feat/test", "job-c2");

    expect(existsSync(wt1)).toBe(true);
    expect(existsSync(wt2)).toBe(true);
    expect(wt1).not.toBe(wt2);

    const content1 = await Bun.file(join(wt1, "file.txt")).text();
    const content2 = await Bun.file(join(wt2, "file.txt")).text();
    expect(content1.trim()).toBe("hello");
    expect(content2.trim()).toBe("hello\nworld");

    await removeWorktree(config, "test-org/test-repo", "job-c1");
    await removeWorktree(config, "test-org/test-repo", "job-c2");
  });
});
