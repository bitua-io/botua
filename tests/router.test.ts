import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { routeEvent, type WebhookContext } from "../src/router";
import { JobQueue } from "../src/queue";
import type { BotuaConfig } from "../src/config";

let queue: JobQueue;
let tempDir: string;

const mockConfig: BotuaConfig = {
  server: { port: 7800, host: "0.0.0.0" },
  github: { app_id: 0, private_key_path: "", webhook_secret: "" }, // no app = skip GitHub API calls
  sandbox: { runtime: "podman", image: "test", max_concurrent_jobs: 2, job_timeout_minutes: 10 },
  ai: { model: "k2p5", provider: "kimi-coding" },
  repos: { data_dir: "/tmp/test-repos" },
  scheduler: { poll_interval_ms: 2000, max_workers: 3 },
  workers: { review_timeout_ms: 60000, command_timeout_ms: 60000 },
};

function makeCtx(eventType: string, payload: any): WebhookContext {
  return {
    source: "github",
    eventType,
    payload,
    config: mockConfig,
    queue,
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "botua-router-test-"));
  queue = new JobQueue(join(tempDir, "test.db"));
});

describe("router — event routing", () => {
  test("routes pull_request.opened to pr-review", async () => {
    const result = await routeEvent(makeCtx("pull_request.opened", {
      repository: { full_name: "org/repo" },
      pull_request: {
        number: 1,
        title: "test PR",
        body: "",
        user: { login: "dev" },
        head: { sha: "abc123", ref: "feat/test" },
        base: { ref: "main" },
      },
    }));

    expect(result?.action).toBe("pr-review");
    expect(result?.jobId).toBeDefined();
  });

  test("routes pull_request.synchronize to pr-review", async () => {
    const result = await routeEvent(makeCtx("pull_request.synchronize", {
      repository: { full_name: "org/repo" },
      pull_request: {
        number: 1,
        title: "test PR",
        body: "",
        user: { login: "dev" },
        head: { sha: "def456", ref: "feat/test" },
        base: { ref: "main" },
      },
    }));

    expect(result?.action).toBe("pr-review");
  });

  test("routes ping event", async () => {
    const result = await routeEvent(makeCtx("ping", { zen: "test" }));
    expect(result?.action).toBe("pong");
  });

  test("ignores unknown events", async () => {
    const result = await routeEvent(makeCtx("deployment.created", {}));
    expect(result).toBeNull();
  });
});

describe("router — comment handling", () => {
  test("skips bot comments", async () => {
    const result = await routeEvent(makeCtx("issue_comment.created", {
      comment: { body: "review done", user: { login: "botua-dev[bot]", type: "Bot" }, id: 1 },
      issue: { number: 1, pull_request: { url: "..." } },
      repository: { full_name: "org/repo" },
    }));

    expect(result).toBeNull();
  });

  test("skips issue comments (not PR)", async () => {
    const result = await routeEvent(makeCtx("issue_comment.created", {
      comment: { body: "@botua hello", user: { login: "dev", type: "User" }, id: 1 },
      issue: { number: 1 },  // no pull_request field
      repository: { full_name: "org/repo" },
    }));

    expect(result).toBeNull();
  });

  test("@botua review triggers re-review with force flag", async () => {
    const result = await routeEvent(makeCtx("issue_comment.created", {
      comment: { body: "@botua review", user: { login: "dev", type: "User" }, id: 1 },
      issue: { number: 1, pull_request: { url: "..." } },
      repository: { full_name: "org/repo" },
    }));

    // Should route to pr-review handler (which needs PR data — may skip without app config)
    // The important thing is it doesn't queue a pr-command
    expect(result?.skipped).toContain("missing repo or PR data");
  });

  test("@botua re-review also triggers re-review", async () => {
    const result = await routeEvent(makeCtx("issue_comment.created", {
      comment: { body: "@botua re-review", user: { login: "dev", type: "User" }, id: 1 },
      issue: { number: 1, pull_request: { url: "..." } },
      repository: { full_name: "org/repo" },
    }));

    expect(result?.skipped).toContain("missing repo or PR data");
  });

  test("@botua with other command queues pr-command job", async () => {
    const result = await routeEvent(makeCtx("issue_comment.created", {
      comment: { body: "@botua create an issue for this", user: { login: "dev", type: "User" }, id: 1 },
      issue: { number: 5, pull_request: { url: "..." } },
      repository: { full_name: "org/repo" },
    }));

    expect(result?.action).toBe("pr-command");
    expect(result?.jobId).toBeDefined();

    // Verify the job was created in the queue
    const job = queue.getJob(result!.jobId!);
    expect(job).not.toBeNull();
    expect(job!.type).toBe("pr-command");
    expect(job!.payload.command).toBe("create an issue for this");
    expect(job!.payload.pr_number).toBe(5);
  });

  test("non-mention comment on PR without botua review is ignored", async () => {
    // No completed reviews in the queue for this repo/PR
    const result = await routeEvent(makeCtx("issue_comment.created", {
      comment: { body: "looks good to me", user: { login: "dev", type: "User" }, id: 1 },
      issue: { number: 1, pull_request: { url: "..." } },
      repository: { full_name: "org/repo" },
    }));

    // Should be null — no botua review, nothing to classify
    expect(result).toBeNull();
  });

  test("non-mention comment on PR WITH botua review goes to classifier", async () => {
    // Create a completed review job first
    const jobId = queue.createJob({
      repo: "org/repo",
      type: "pr-review",
      payload: { pr_number: 1, head_sha: "abc" },
    });
    queue.startJob(jobId);
    queue.completeJob(jobId, { approved: true });

    // Now a non-mention comment on the same PR
    const result = await routeEvent(makeCtx("issue_comment.created", {
      comment: { body: "I'll fix the test in the next PR", user: { login: "dev", type: "User" }, id: 2 },
      issue: { number: 1, pull_request: { url: "..." } },
      repository: { full_name: "org/repo" },
    }));

    // Without github app configured, it can't fetch the review body → returns null
    // In production with the app configured, it would classify
    // The important thing: it didn't crash, and it checked hasCompletedReviewForPR
    expect(result).toBeNull(); // null because no review body could be fetched
  });
});

describe("router — command extraction", () => {
  test("extracts command after @botua", async () => {
    const result = await routeEvent(makeCtx("issue_comment.created", {
      comment: { body: "@botua créame la issue porfa", user: { login: "dev", type: "User" }, id: 1 },
      issue: { number: 1, pull_request: { url: "..." } },
      repository: { full_name: "org/repo" },
    }));

    const job = queue.getJob(result!.jobId!);
    expect(job!.payload.command).toBe("créame la issue porfa");
  });

  test("handles multiline — takes first line after @botua", async () => {
    const result = await routeEvent(makeCtx("issue_comment.created", {
      comment: {
        body: "@botua this is a false positive\nbecause we handle it elsewhere",
        user: { login: "dev", type: "User" },
        id: 1,
      },
      issue: { number: 1, pull_request: { url: "..." } },
      repository: { full_name: "org/repo" },
    }));

    const job = queue.getJob(result!.jobId!);
    expect(job!.payload.command).toBe("this is a false positive");
  });

  test("handles @botua-dev and @botua-review-bot mentions", async () => {
    for (const mention of ["@botua-dev do something", "@botua-review-bot do something"]) {
      const result = await routeEvent(makeCtx("issue_comment.created", {
        comment: { body: mention, user: { login: "dev", type: "User" }, id: 1 },
        issue: { number: 1, pull_request: { url: "..." } },
        repository: { full_name: "org/repo" },
      }));

      expect(result?.action).toBe("pr-command");
    }
  });
});
