import { describe, expect, test, beforeEach } from "bun:test";
import { JobQueue } from "../src/queue";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let queue: JobQueue;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "botua-queue-test-"));
  queue = new JobQueue(join(tempDir, "test.db"));
});

describe("job queue", () => {
  test("creates and retrieves a job", () => {
    const id = queue.createJob({ repo: "org/repo", type: "pr-review", payload: { pr: 1 } });
    const job = queue.getJob(id);

    expect(job).not.toBeNull();
    expect(job!.repo).toBe("org/repo");
    expect(job!.type).toBe("pr-review");
    expect(job!.status).toBe("queued");
    expect(job!.payload).toEqual({ pr: 1 });
  });

  test("nextJob returns oldest queued job", () => {
    queue.createJob({ repo: "org/a", type: "pr-review", payload: {} });
    const secondId = queue.createJob({ repo: "org/b", type: "pr-review", payload: {} });

    const first = queue.nextJob();
    expect(first).not.toBeNull();
    expect(first!.repo).toBe("org/a");
  });

  test("nextJob skips repos with running jobs", () => {
    const id1 = queue.createJob({ repo: "org/a", type: "pr-review", payload: {} });
    const id2 = queue.createJob({ repo: "org/a", type: "pr-review", payload: {} });
    const id3 = queue.createJob({ repo: "org/b", type: "pr-review", payload: {} });

    queue.startJob(id1);

    const next = queue.nextJob();
    expect(next).not.toBeNull();
    expect(next!.repo).toBe("org/b");
  });

  test("nextJob respects max concurrent limit", () => {
    const q = new JobQueue(join(tempDir, "limit.db"), 1);
    const id1 = q.createJob({ repo: "org/a", type: "pr-review", payload: {} });
    q.createJob({ repo: "org/b", type: "pr-review", payload: {} });

    q.startJob(id1);

    const next = q.nextJob();
    expect(next).toBeNull();
  });

  test("completeJob sets status and result", () => {
    const id = queue.createJob({ repo: "org/a", type: "pr-review", payload: {} });
    queue.startJob(id);
    queue.completeJob(id, { approved: true });

    const job = queue.getJob(id);
    expect(job!.status).toBe("complete");
    expect(job!.result).toEqual({ approved: true });
    expect(job!.completed_at).toBeGreaterThan(0);
  });

  test("failJob sets status and error", () => {
    const id = queue.createJob({ repo: "org/a", type: "pr-review", payload: {} });
    queue.startJob(id);
    queue.failJob(id, "timeout");

    const job = queue.getJob(id);
    expect(job!.status).toBe("failed");
    expect(job!.result).toEqual({ error: "timeout" });
  });

  test("stats returns correct counts", () => {
    const id1 = queue.createJob({ repo: "org/a", type: "pr-review", payload: {} });
    const id2 = queue.createJob({ repo: "org/b", type: "pr-review", payload: {} });
    queue.startJob(id1);
    queue.completeJob(id1, {});
    queue.startJob(id2);

    const stats = queue.stats();
    expect(stats.completed).toBe(1);
    expect(stats.running).toBe(1);
    expect(stats.queued).toBe(0);
  });

  test("logEvent and linkEventToJob", () => {
    const eventId = queue.logEvent("github", "pull_request.opened", "org/a", '{"action":"opened"}');
    const jobId = queue.createJob({ repo: "org/a", type: "pr-review", payload: {} });
    queue.linkEventToJob(eventId, jobId);

    const events = queue.recentEvents(1);
    expect(events).toHaveLength(1);
    expect(events[0].job_id).toBe(jobId);
  });
});

describe("memories", () => {
  test("addMemory and getMemories", () => {
    queue.addMemory({
      repo: "org/repo",
      category: "convention",
      content: "uses biome for linting",
      sourceJobId: "job-1",
    });
    queue.addMemory({
      repo: "org/repo",
      category: "pattern",
      content: "NestJS modules",
      sourceJobId: "job-1",
    });
    queue.addMemory({
      repo: "org/other",
      category: "convention",
      content: "uses eslint",
      sourceJobId: "job-2",
    });

    const all = queue.getMemories("org/repo");
    expect(all).toHaveLength(2);

    const conventions = queue.getMemories("org/repo", "convention");
    expect(conventions).toHaveLength(1);
    expect(conventions[0].content).toBe("uses biome for linting");

    const other = queue.getMemories("org/other");
    expect(other).toHaveLength(1);
  });

  test("pruneExpiredMemories removes expired entries", () => {
    queue.addMemory({
      repo: "org/repo",
      category: "context",
      content: "ephemeral data",
      sourceJobId: "job-1",
      expiresAt: Date.now() - 1000, // already expired
    });
    queue.addMemory({
      repo: "org/repo",
      category: "convention",
      content: "permanent data",
      sourceJobId: "job-1",
    });

    const pruned = queue.pruneExpiredMemories();
    expect(pruned).toBe(1);

    const remaining = queue.getMemories("org/repo");
    expect(remaining).toHaveLength(1);
    expect(remaining[0].content).toBe("permanent data");
  });
});
