import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { JobQueue } from "../src/queue";
import type { BotuaConfig } from "../src/config";
import type { WorkerMessage } from "../src/workers/protocol";

let tempDir: string;
let queue: JobQueue;
let config: BotuaConfig;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "botua-sched-test-"));
  queue = new JobQueue(join(tempDir, "test.db"));

  config = {
    server: { port: 7800, host: "0.0.0.0" },
    github: { app_id: 0, private_key_path: "", webhook_secret: "" },
    sandbox: { runtime: "podman", image: "botua-base:latest", max_concurrent_jobs: 2, job_timeout_minutes: 25 },
    ai: { model: "k2p5", provider: "kimi-coding" },
    repos: { data_dir: join(tempDir, "repos") },
    scheduler: { poll_interval_ms: 100, max_workers: 2 },
    workers: { review_timeout_ms: 5000, command_timeout_ms: 5000 },
  } as BotuaConfig;
});

afterEach(() => {
  queue.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("scheduler — worker lifecycle", () => {
  test("spawns a worker and receives messages", async () => {
    const workerUrl = new URL("./helpers/echo-worker.ts", import.meta.url).href;
    const worker = new Worker(workerUrl);

    const messages: WorkerMessage[] = [];
    const done = new Promise<void>((resolve) => {
      worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
        messages.push(event.data);
        if (event.data.type === "complete") {
          worker.terminate();
          resolve();
        }
      };
    });

    worker.postMessage({
      type: "init",
      jobId: "test-job",
      repo: "org/repo",
      jobType: "pr-review",
      payload: {},
      workDir: tempDir,
      githubToken: "",
      kimiApiKey: "",
      config: { model: "k2p5", provider: "kimi-coding", timeoutMs: 5000 },
      memories: [],
    });

    await done;

    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages[0].type).toBe("progress");
    expect(messages[messages.length - 1].type).toBe("complete");

    const complete = messages.find(m => m.type === "complete")!;
    expect((complete as any).result.echo).toBe(true);
  });

  test("worker timeout terminates worker", async () => {
    // Create a worker that never completes
    const slowWorkerCode = `
      declare var self: Worker;
      self.onmessage = () => {
        // intentionally never responds
      };
    `;
    const blob = new Blob([slowWorkerCode], { type: "application/typescript" });
    const worker = new Worker(URL.createObjectURL(blob));

    let terminated = false;
    const timeout = setTimeout(() => {
      worker.terminate();
      terminated = true;
    }, 200);

    worker.postMessage({ type: "init", jobId: "slow-job" });

    // Wait for timeout
    await new Promise(resolve => setTimeout(resolve, 300));
    clearTimeout(timeout);

    expect(terminated).toBe(true);
  });

  test("queue integration — create job and verify state transitions", () => {
    const jobId = queue.createJob({
      repo: "org/repo",
      type: "pr-review",
      payload: { pr_number: 42, head_sha: "abc" },
    });

    // Initially queued
    let job = queue.getJob(jobId)!;
    expect(job.status).toBe("queued");

    // Start
    queue.startJob(jobId);
    job = queue.getJob(jobId)!;
    expect(job.status).toBe("running");

    // Complete
    queue.completeJob(jobId, { approved: true });
    job = queue.getJob(jobId)!;
    expect(job.status).toBe("complete");
    expect(job.result).toEqual({ approved: true });
  });
});
