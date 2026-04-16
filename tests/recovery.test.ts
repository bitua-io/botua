import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { JobQueue } from "../src/queue";
import { recoverInterruptedJobs } from "../src/recovery";
import type { BotuaConfig } from "../src/config";

let tempDir: string;
let queue: JobQueue;
let config: BotuaConfig;
let originalFetch: typeof fetch;
let originalToken: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "botua-recovery-test-"));
  queue = new JobQueue(join(tempDir, "test.db"));
  config = {
    repos: { data_dir: join(tempDir, "repos") },
    github: { app_id: 0, private_key_path: "", webhook_secret: "" },
  } as BotuaConfig;
  originalFetch = globalThis.fetch;
  originalToken = process.env.GITHUB_TOKEN;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalToken !== undefined) {
    process.env.GITHUB_TOKEN = originalToken;
  } else {
    delete process.env.GITHUB_TOKEN;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe("recoverInterruptedJobs", () => {
  test("marks interrupted running jobs as failed", async () => {
    const id1 = queue.createJob({
      repo: "owner/repo",
      type: "pr-review",
      payload: { pr_number: 1 },
    });
    const id2 = queue.createJob({
      repo: "owner/repo",
      type: "pr-review",
      payload: { pr_number: 2 },
    });
    queue.startJob(id1);
    queue.startJob(id2);

    const result = await recoverInterruptedJobs(config, queue);

    expect(result.recovered).toBe(2);
    expect(result.checkRunsUpdated).toBe(0);

    const job1 = queue.getJob(id1);
    expect(job1!.status).toBe("failed");
    expect(job1!.result).toEqual({ error: "Service restart interrupted this job" });

    const job2 = queue.getJob(id2);
    expect(job2!.status).toBe("failed");
    expect(job2!.result).toEqual({ error: "Service restart interrupted this job" });
  });

  test("does not touch non-running jobs", async () => {
    const queued = queue.createJob({
      repo: "owner/repo",
      type: "pr-review",
      payload: { pr_number: 1 },
    });
    const completed = queue.createJob({
      repo: "owner/repo",
      type: "pr-review",
      payload: { pr_number: 2 },
    });
    const failed = queue.createJob({
      repo: "owner/repo",
      type: "pr-review",
      payload: { pr_number: 3 },
    });
    queue.startJob(completed);
    queue.completeJob(completed, { ok: true });
    queue.startJob(failed);
    queue.failJob(failed, "some error");

    const result = await recoverInterruptedJobs(config, queue);

    expect(result.recovered).toBe(0);
    expect(queue.getJob(queued)!.status).toBe("queued");
    expect(queue.getJob(completed)!.status).toBe("complete");
    expect(queue.getJob(failed)!.status).toBe("failed");
  });

  test("jobs without check_run_id skip the GitHub API call gracefully", async () => {
    const fetchMock = mock(() => Promise.resolve(new Response(JSON.stringify({}), { status: 200 })));
    globalThis.fetch = fetchMock;
    process.env.GITHUB_TOKEN = "fake-token";

    const id = queue.createJob({
      repo: "owner/repo",
      type: "pr-review",
      payload: { head_sha: "abc123" }, // no check_run_id
    });
    queue.startJob(id);

    const result = await recoverInterruptedJobs(config, queue);

    expect(result.recovered).toBe(1);
    expect(result.checkRunsUpdated).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("updates check run when check_run_id and head_sha are present", async () => {
    const fetchMock = mock(() => Promise.resolve(new Response(JSON.stringify({}), { status: 200 })));
    globalThis.fetch = fetchMock;
    process.env.GITHUB_TOKEN = "fake-token";

    const id = queue.createJob({
      repo: "owner/repo",
      type: "pr-review",
      payload: { check_run_id: 12345, head_sha: "abc123" },
    });
    queue.startJob(id);

    const result = await recoverInterruptedJobs(config, queue);

    expect(result.recovered).toBe(1);
    expect(result.checkRunsUpdated).toBe(1);
    expect(fetchMock).toHaveBeenCalled();

    const calls = fetchMock.mock.calls as unknown as Array<[string, { method: string; body: string; headers: Record<string, string> }]>;
    const patchCall = calls.find(([url, init]) => url.includes("/check-runs/12345") && init.method === "PATCH");
    expect(patchCall).toBeDefined();

    const body = JSON.parse(patchCall![1].body);
    expect(body.status).toBe("completed");
    expect(body.conclusion).toBe("neutral");
    expect(body.output.title).toBe("Botua — Review interrupted");
    expect(body.output.summary).toContain("Push a new commit or comment `@botua review`");
  });

  test("removes stale worktree directories matching job-*", async () => {
    const reposDir = config.repos.data_dir;
    const ownerDir = join(reposDir, "owner");
    const worktreesDir = join(ownerDir, "repo-worktrees");
    const jobDir = join(worktreesDir, "job-abc-123");
    mkdirSync(jobDir, { recursive: true });
    await Bun.write(join(jobDir, "file.txt"), "hello");

    const result = await recoverInterruptedJobs(config, queue);

    expect(result.worktreesCleaned).toBe(1);
    expect(existsSync(jobDir)).toBe(false);
  });

  test("returns accurate counts", async () => {
    process.env.GITHUB_TOKEN = "fake-token";
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({}), { status: 200 })));

    const id1 = queue.createJob({
      repo: "owner/repo",
      type: "pr-review",
      payload: { check_run_id: 1, head_sha: "a" },
    });
    const id2 = queue.createJob({
      repo: "owner/repo",
      type: "pr-review",
      payload: { check_run_id: 2, head_sha: "b" },
    });
    queue.startJob(id1);
    queue.startJob(id2);

    const reposDir = config.repos.data_dir;
    mkdirSync(join(reposDir, "owner", "repo-worktrees", "job-x"), { recursive: true });
    mkdirSync(join(reposDir, "owner", "repo-worktrees", "job-y"), { recursive: true });

    const result = await recoverInterruptedJobs(config, queue);

    expect(result.recovered).toBe(2);
    expect(result.checkRunsUpdated).toBe(2);
    expect(result.worktreesCleaned).toBe(2);
  });

  test("is idempotent — second call returns zeroes", async () => {
    process.env.GITHUB_TOKEN = "fake-token";
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({}), { status: 200 })));

    const id = queue.createJob({
      repo: "owner/repo",
      type: "pr-review",
      payload: { check_run_id: 1, head_sha: "a" },
    });
    queue.startJob(id);

    const reposDir = config.repos.data_dir;
    mkdirSync(join(reposDir, "owner", "repo-worktrees", "job-z"), { recursive: true });

    const first = await recoverInterruptedJobs(config, queue);
    expect(first.recovered).toBe(1);
    expect(first.checkRunsUpdated).toBe(1);
    expect(first.worktreesCleaned).toBe(1);

    const second = await recoverInterruptedJobs(config, queue);
    expect(second.recovered).toBe(0);
    expect(second.checkRunsUpdated).toBe(0);
    expect(second.worktreesCleaned).toBe(0);
  });

  test("gracefully handles missing GITHUB_TOKEN and no app config", async () => {
    delete process.env.GITHUB_TOKEN;
    const id = queue.createJob({
      repo: "owner/repo",
      type: "pr-review",
      payload: { check_run_id: 99, head_sha: "abc" },
    });
    queue.startJob(id);

    const result = await recoverInterruptedJobs(config, queue);

    expect(result.recovered).toBe(1);
    expect(result.checkRunsUpdated).toBe(0);
    expect(queue.getJob(id)!.status).toBe("failed");
  });

  test("gracefully handles GitHub API errors and continues", async () => {
    const fetchMock = mock(() => Promise.resolve(new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })));
    globalThis.fetch = fetchMock;
    process.env.GITHUB_TOKEN = "fake-token";

    const id1 = queue.createJob({
      repo: "owner/repo",
      type: "pr-review",
      payload: { check_run_id: 1, head_sha: "a" },
    });
    const id2 = queue.createJob({
      repo: "owner/repo",
      type: "pr-review",
      payload: { check_run_id: 2, head_sha: "b" },
    });
    queue.startJob(id1);
    queue.startJob(id2);

    const result = await recoverInterruptedJobs(config, queue);

    expect(result.recovered).toBe(2);
    expect(result.checkRunsUpdated).toBe(0);
    expect(queue.getJob(id1)!.status).toBe("failed");
    expect(queue.getJob(id2)!.status).toBe("failed");
  });
});
