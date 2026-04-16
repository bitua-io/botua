import { describe, expect, test, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { JobQueue } from "../src/queue";
import { setupGracefulShutdown } from "../src/shutdown";
import type { BotuaConfig } from "../src/config";
import type { ActiveWorker } from "../src/scheduler";

let tempDir: string;
let queue: JobQueue;
let config: BotuaConfig;
let server: { stop: () => void; stopped: boolean };
let scheduler: { stop: ReturnType<typeof mock>; activeWorkers: Map<string, ActiveWorker> };
let originalFetch: typeof fetch;
let sigtermHandler: any;
let sigintHandler: any;
let exitSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "botua-shutdown-test-"));
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

  server = { stop: mock(() => { server.stopped = true; }), stopped: false };
  scheduler = { stop: mock(() => {}), activeWorkers: new Map() };

  originalFetch = globalThis.fetch;

  exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);

  const beforeTerm = process.listenerCount("SIGTERM");
  const beforeInt = process.listenerCount("SIGINT");

  setupGracefulShutdown(config, queue, server, scheduler, 500);

  expect(process.listenerCount("SIGTERM")).toBe(beforeTerm + 1);
  expect(process.listenerCount("SIGINT")).toBe(beforeInt + 1);

  sigtermHandler = process.listeners("SIGTERM")[process.listeners("SIGTERM").length - 1];
  sigintHandler = process.listeners("SIGINT")[process.listeners("SIGINT").length - 1];
});

afterEach(() => {
  if (sigtermHandler) process.removeListener("SIGTERM", sigtermHandler);
  if (sigintHandler) process.removeListener("SIGINT", sigintHandler);
  exitSpy.mockRestore();
  globalThis.fetch = originalFetch;
  queue.close();
  rmSync(tempDir, { recursive: true, force: true });

  for (const active of scheduler.activeWorkers.values()) {
    clearTimeout(active.timeout);
  }
  scheduler.activeWorkers.clear();
});

describe("shutdown", () => {
  test("registers SIGTERM and SIGINT handlers", () => {
    expect(typeof sigtermHandler).toBe("function");
    expect(typeof sigintHandler).toBe("function");
  });

  test("on shutdown, active jobs get marked failed and workers terminated", async () => {
    const jobId = queue.createJob({
      repo: "owner/repo",
      type: "pr-review",
      payload: { pr_number: 1, head_sha: "abc" },
    });
    queue.startJob(jobId);

    const terminateMock = mock(() => {});
    const fakeWorker = { terminate: terminateMock } as unknown as Worker;

    scheduler.activeWorkers.set(jobId, {
      worker: fakeWorker,
      jobId,
      repo: "owner/repo",
      timeout: setTimeout(() => {}, 999999),
      payload: { pr_number: 1, head_sha: "abc" },
      token: "fake-token",
      progressSteps: [],
    });

    // Prevent shutdown from closing DB so we can verify job state
    const closeSpy = spyOn(queue, "close").mockImplementation(() => {});

    sigtermHandler();

    await new Promise(resolve => setTimeout(resolve, 100));

    expect(server.stopped).toBe(true);
    expect(scheduler.stop).toHaveBeenCalled();
    expect(terminateMock).toHaveBeenCalled();

    const job = queue.getJob(jobId)!;
    expect(job.status).toBe("failed");
    expect(job.result).toEqual({ error: "Cancelled by shutdown" });

    closeSpy.mockRestore();
  });

  test("on shutdown, check runs get updated to cancelled", async () => {
    const fetchCalls: Array<{ url: string; body: any }> = [];
    globalThis.fetch = mock(async (url: string | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : (url as Request).url;
      if (urlStr.includes("/check-runs/")) {
        fetchCalls.push({ url: urlStr, body: init?.body ? JSON.parse(init.body as string) : null });
        return new Response(JSON.stringify({}), { status: 200 });
      }
      return originalFetch(url as any, init as any);
    });

    const jobId = queue.createJob({
      repo: "owner/repo",
      type: "pr-review",
      payload: { pr_number: 1, head_sha: "abc", check_run_id: 12345 },
    });
    queue.startJob(jobId);

    const fakeWorker = { terminate: mock(() => {}) } as unknown as Worker;

    scheduler.activeWorkers.set(jobId, {
      worker: fakeWorker,
      jobId,
      repo: "owner/repo",
      timeout: setTimeout(() => {}, 999999),
      payload: { pr_number: 1, head_sha: "abc", check_run_id: 12345 },
      token: "fake-token",
      progressSteps: [],
    });

    sigtermHandler();

    await new Promise(resolve => setTimeout(resolve, 100));

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toContain("/check-runs/12345");
    expect(fetchCalls[0].body.status).toBe("completed");
    expect(fetchCalls[0].body.conclusion).toBe("cancelled");
    expect(fetchCalls[0].body.output.title).toBe("Botua — Review cancelled");
    expect(fetchCalls[0].body.output.summary).toContain("@botua review");
  });

  test("DB gets closed on shutdown", async () => {
    const closeSpy = spyOn(queue, "close");

    sigtermHandler();

    await new Promise(resolve => setTimeout(resolve, 100));

    expect(closeSpy).toHaveBeenCalled();
    closeSpy.mockRestore();
  });

  test("server gets stopped on shutdown", async () => {
    sigtermHandler();

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(server.stop).toHaveBeenCalled();
  });

  test("multiple signals don't double-run shutdown", async () => {
    sigtermHandler();
    sigtermHandler();
    sigintHandler();

    await new Promise(resolve => setTimeout(resolve, 100));

    expect(server.stop).toHaveBeenCalledTimes(1);
    expect(scheduler.stop).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  test("exits with 0 when shutdown succeeds", async () => {
    sigtermHandler();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test("exits within timeout even if check run update hangs", async () => {
    globalThis.fetch = mock(async () => {
      return new Promise(() => {});
    });

    const jobId = queue.createJob({
      repo: "owner/repo",
      type: "pr-review",
      payload: { check_run_id: 99999 },
    });
    queue.startJob(jobId);

    const fakeWorker = { terminate: mock(() => {}) } as unknown as Worker;
    scheduler.activeWorkers.set(jobId, {
      worker: fakeWorker,
      jobId,
      repo: "owner/repo",
      timeout: setTimeout(() => {}, 999999),
      payload: { check_run_id: 99999 },
      token: "token",
      progressSteps: [],
    });

    sigtermHandler();

    await new Promise(resolve => setTimeout(resolve, 700));

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
