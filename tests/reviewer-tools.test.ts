import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createReviewerTools } from "../src/reviewer-tools";

let tempDir: string;
let repoDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "botua-tools-test-"));
  repoDir = join(tempDir, "repo");

  // Create a git repo with two branches
  Bun.spawnSync(["git", "init", repoDir], { stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: repoDir, stdout: "pipe" });
  Bun.spawnSync(["git", "config", "user.name", "test"], { cwd: repoDir, stdout: "pipe" });
  Bun.spawnSync(["git", "checkout", "-b", "main"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["bash", "-c", `
    echo 'original content' > file.ts
    echo 'import { foo } from "./file"' > consumer.ts
    git add . && git commit -m 'init'
  `], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });

  // Feature branch with changes
  Bun.spawnSync(["bash", "-c", `
    git checkout -b feat/test
    echo 'modified content' > file.ts
    echo 'new file' > newfile.ts
    git add . && git commit -m 'feat'
  `], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const prData = {
  title: "feat: add new feature",
  body: "This adds a great feature",
  author: "marco",
  baseBranch: "main",
  headBranch: "feat/test",
  headSha: "abc123",
  changedFiles: ["file.ts", "newfile.ts"],
  labels: ["enhancement"],
  owner: "bitua-io",
  repo: "platform",
};

describe("reviewer tools", () => {
  test("createReviewerTools returns tool definitions", () => {
    const progressSteps: string[] = [];
    const tools = createReviewerTools(prData, repoDir, (step) => progressSteps.push(step));

    expect(tools.length).toBeGreaterThanOrEqual(5);
    const names = tools.map(t => t.name);
    expect(names).toContain("report_progress");
    expect(names).toContain("get_pr_info");
    expect(names).toContain("read_file_at_base");
    expect(names).toContain("get_ci_status");
    expect(names).toContain("list_related_files");
  });

  test("report_progress calls callback", async () => {
    const progressSteps: string[] = [];
    const tools = createReviewerTools(prData, repoDir, (step) => progressSteps.push(step));
    const tool = tools.find(t => t.name === "report_progress")!;

    const result = await tool.execute("call-1", { status: "Reading files" }, undefined, undefined, {} as any);
    expect(progressSteps).toContain("Reading files");
    expect(result.content[0].text).toContain("Progress reported");
  });

  test("get_pr_info returns PR metadata", async () => {
    const tools = createReviewerTools(prData, repoDir, () => {});
    const tool = tools.find(t => t.name === "get_pr_info")!;

    const result = await tool.execute("call-1", {}, undefined, undefined, {} as any);
    const info = JSON.parse(result.content[0].text);
    expect(info.title).toBe("feat: add new feature");
    expect(info.author).toBe("marco");
    expect(info.changedFiles).toEqual(["file.ts", "newfile.ts"]);
  });

  test("read_file_at_base reads file from base branch", async () => {
    const tools = createReviewerTools(prData, repoDir, () => {});
    const tool = tools.find(t => t.name === "read_file_at_base")!;

    const result = await tool.execute("call-1", { path: "file.ts" }, undefined, undefined, {} as any);
    expect(result.content[0].text.trim()).toBe("original content");
  });

  test("read_file_at_base handles new files", async () => {
    const tools = createReviewerTools(prData, repoDir, () => {});
    const tool = tools.find(t => t.name === "read_file_at_base")!;

    const result = await tool.execute("call-1", { path: "newfile.ts" }, undefined, undefined, {} as any);
    expect(result.content[0].text).toContain("not found in base branch");
  });

  test("list_related_files finds dependents", async () => {
    const tools = createReviewerTools(prData, repoDir, () => {});
    const tool = tools.find(t => t.name === "list_related_files")!;

    const result = await tool.execute("call-1", { path: "file.ts" }, undefined, undefined, {} as any);
    expect(result.content[0].text).toContain("consumer.ts");
  });
});
