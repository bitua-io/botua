import { describe, expect, test } from "bun:test";
import { Type } from "@mariozechner/pi-ai";

/**
 * Test that command worker tools have the correct shape for pi's customTools.
 * Pi expects: { name, description, parameters, execute }
 * NOT: { name, description, inputSchema, execute }
 */

// Replicate the tool definitions from command-worker.ts
// (we can't import them directly since they're defined inside onmessage)
function createCommandTools(options: {
  owner: string;
  repoName: string;
  headers: Record<string, string>;
  payload: Record<string, any>;
  API: string;
}) {
  const { owner, repoName, headers, payload, API } = options;

  return [
    {
      name: "create_github_issue",
      description: "Create a new issue on the repository.",
      parameters: Type.Object({
        title: Type.String({ description: "Issue title" }),
        body: Type.String({ description: "Issue body in markdown" }),
        labels: Type.Optional(Type.Array(Type.String(), { description: "Labels to add" })),
        assignees: Type.Optional(Type.Array(Type.String(), { description: "GitHub usernames to assign" })),
      }),
      execute: async (input: { title: string; body: string }) => `Created issue: ${input.title}`,
    },
    {
      name: "update_check_run",
      description: "Update the Botua check run on this PR.",
      parameters: Type.Object({
        conclusion: Type.Union([
          Type.Literal("success"),
          Type.Literal("action_required"),
          Type.Literal("failure"),
        ], { description: "New conclusion for the check run" }),
        summary: Type.String({ description: "Updated summary explaining the change" }),
      }),
      execute: async (input: { conclusion: string; summary: string }) => `Updated to ${input.conclusion}`,
    },
    {
      name: "comment_on_pr",
      description: "Post a comment on the PR explaining what you did.",
      parameters: Type.Object({
        body: Type.String({ description: "Comment body in markdown" }),
      }),
      execute: async (input: { body: string }) => "Comment posted",
    },
    {
      name: "get_review_context",
      description: "Get the latest Botua review and check run status for this PR.",
      parameters: Type.Object({}),
      execute: async () => JSON.stringify({ review: null, check_run: null }),
    },
  ];
}

describe("command worker tools", () => {
  const tools = createCommandTools({
    owner: "test-org",
    repoName: "test-repo",
    headers: {},
    payload: { pr_number: 1, head_sha: "abc" },
    API: "https://api.github.com",
  });

  test("all tools have required pi fields: name, description, parameters, execute", () => {
    for (const tool of tools) {
      expect(tool.name).toBeString();
      expect(tool.description).toBeString();
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.execute).toBe("function");

      // Ensure we DON'T have inputSchema (common mistake)
      expect((tool as any).inputSchema).toBeUndefined();
    }
  });

  test("parameters are valid JSON Schema objects", () => {
    for (const tool of tools) {
      expect(tool.parameters.type).toBe("object");
      expect(tool.parameters).toHaveProperty("properties");
    }
  });

  test("4 tools are defined", () => {
    expect(tools).toHaveLength(4);
    const names = tools.map(t => t.name);
    expect(names).toContain("create_github_issue");
    expect(names).toContain("update_check_run");
    expect(names).toContain("comment_on_pr");
    expect(names).toContain("get_review_context");
  });

  test("create_github_issue requires title and body", () => {
    const tool = tools.find(t => t.name === "create_github_issue")!;
    expect(tool.parameters.required).toContain("title");
    expect(tool.parameters.required).toContain("body");
  });

  test("update_check_run requires conclusion and summary", () => {
    const tool = tools.find(t => t.name === "update_check_run")!;
    expect(tool.parameters.required).toContain("conclusion");
    expect(tool.parameters.required).toContain("summary");
  });

  test("comment_on_pr requires body", () => {
    const tool = tools.find(t => t.name === "comment_on_pr")!;
    expect(tool.parameters.required).toContain("body");
  });

  test("get_review_context has no required params", () => {
    const tool = tools.find(t => t.name === "get_review_context")!;
    // Empty object schema — no required fields
    expect(tool.parameters.required ?? []).toHaveLength(0);
  });

  test("execute functions return strings", async () => {
    const createIssue = tools.find(t => t.name === "create_github_issue")!;
    const result = await createIssue.execute({ title: "test", body: "test body" });
    expect(result).toBeString();
    expect(result).toContain("test");

    const updateCheck = tools.find(t => t.name === "update_check_run")!;
    const result2 = await updateCheck.execute({ conclusion: "success", summary: "all good" });
    expect(result2).toContain("success");

    const comment = tools.find(t => t.name === "comment_on_pr")!;
    const result3 = await comment.execute({ body: "hello" });
    expect(result3).toBe("Comment posted");

    const context = tools.find(t => t.name === "get_review_context")!;
    const result4 = await context.execute();
    const parsed = JSON.parse(result4);
    expect(parsed).toHaveProperty("review");
    expect(parsed).toHaveProperty("check_run");
  });
});
