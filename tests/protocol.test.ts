import { describe, expect, test } from "bun:test";
import {
  type InitMessage,
  type ProgressMessage,
  type CompleteMessage,
  type ErrorMessage,
  type MemoryMessage,
  type WorkerMessage,
  isProgressMessage,
  isCompleteMessage,
  isErrorMessage,
  isMemoryMessage,
} from "../src/workers/protocol";

describe("worker protocol", () => {
  const init: InitMessage = {
    type: "init",
    jobId: "job-1",
    repo: "bitua-io/platform",
    jobType: "pr-review",
    payload: { pr_number: 42, title: "feat: test" },
    workDir: "/tmp/worktree",
    githubToken: "ghs_xxx",
    kimiApiKey: "sk-kimi-xxx",
    config: { model: "k2p5", provider: "kimi-coding", timeoutMs: 60000 },
    memories: [{ category: "convention", content: "uses biome for linting" }],
  };

  const progress: ProgressMessage = {
    type: "progress",
    jobId: "job-1",
    step: "Reading changed files",
  };

  const complete: CompleteMessage = {
    type: "complete",
    jobId: "job-1",
    result: { approved: true, issues: 0 },
  };

  const error: ErrorMessage = {
    type: "error",
    jobId: "job-1",
    error: "pi session crashed",
  };

  const memory: MemoryMessage = {
    type: "memory",
    jobId: "job-1",
    repo: "bitua-io/platform",
    category: "convention",
    content: "uses drizzle ORM",
  };

  test("isProgressMessage identifies progress messages", () => {
    expect(isProgressMessage(progress)).toBe(true);
    expect(isProgressMessage(complete)).toBe(false);
    expect(isProgressMessage(error)).toBe(false);
    expect(isProgressMessage(init)).toBe(false);
  });

  test("isCompleteMessage identifies complete messages", () => {
    expect(isCompleteMessage(complete)).toBe(true);
    expect(isCompleteMessage(progress)).toBe(false);
    expect(isCompleteMessage(error)).toBe(false);
  });

  test("isErrorMessage identifies error messages", () => {
    expect(isErrorMessage(error)).toBe(true);
    expect(isErrorMessage(complete)).toBe(false);
    expect(isErrorMessage(progress)).toBe(false);
  });

  test("isMemoryMessage identifies memory messages", () => {
    expect(isMemoryMessage(memory)).toBe(true);
    expect(isMemoryMessage(progress)).toBe(false);
    expect(isMemoryMessage(complete)).toBe(false);
  });

  test("InitMessage has all required fields", () => {
    expect(init.type).toBe("init");
    expect(init.jobId).toBe("job-1");
    expect(init.repo).toBe("bitua-io/platform");
    expect(init.jobType).toBe("pr-review");
    expect(init.workDir).toBe("/tmp/worktree");
    expect(init.githubToken).toStartWith("ghs_");
    expect(init.kimiApiKey).toStartWith("sk-kimi-");
    expect(init.config.model).toBe("k2p5");
    expect(init.memories).toHaveLength(1);
  });

  test("type guards work with arbitrary objects", () => {
    expect(isProgressMessage({ type: "progress" })).toBe(false); // missing jobId
    expect(isProgressMessage(null)).toBe(false);
    expect(isProgressMessage(undefined)).toBe(false);
    expect(isProgressMessage("string")).toBe(false);
    expect(isCompleteMessage({ type: "complete", jobId: "x" })).toBe(false); // missing result
  });
});
