import { describe, expect, test } from "bun:test";
import { Type } from "@mariozechner/pi-ai";

/**
 * Test that command worker tools match pi's customTools contract:
 * - { name, description, parameters, execute }
 * - execute(toolCallId, params, ...) → { content: [{ type: "text", text }], details: {} }
 * - parameters is a TypeBox/JSON Schema object
 */

/** Helper matching the one in command-worker.ts */
function toolResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function createCommandTools() {
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
      async execute(_id: string, params: any) {
        return toolResult(`Created issue: ${params.title}`);
      },
    },
    {
      name: "get_github_issue",
      description: "Read an existing issue by number.",
      parameters: Type.Object({
        issue_number: Type.Number({ description: "Issue number" }),
      }),
      async execute(_id: string, params: any) {
        return toolResult(JSON.stringify({ number: params.issue_number, title: "Test", body: "content" }));
      },
    },
    {
      name: "update_github_issue",
      description: "Update an existing issue.",
      parameters: Type.Object({
        issue_number: Type.Number({ description: "Issue number to update" }),
        title: Type.Optional(Type.String({ description: "New title" })),
        body: Type.Optional(Type.String({ description: "New body" })),
        state: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("closed")])),
        labels: Type.Optional(Type.Array(Type.String())),
      }),
      async execute(_id: string, params: any) {
        return toolResult(`Updated issue #${params.issue_number}`);
      },
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
      async execute(_id: string, params: any) {
        return toolResult(`Updated to ${params.conclusion}`);
      },
    },
    {
      name: "comment_on_pr",
      description: "Post a comment on the PR explaining what you did.",
      parameters: Type.Object({
        body: Type.String({ description: "Comment body in markdown" }),
      }),
      async execute(_id: string, params: any) {
        return toolResult("Comment posted");
      },
    },
    {
      name: "get_review_context",
      description: "Get the latest Botua review and check run status for this PR.",
      parameters: Type.Object({}),
      async execute() {
        return toolResult(JSON.stringify({ review: null, check_run: null }));
      },
    },
  ];
}

describe("command worker tools — pi contract", () => {
  const tools = createCommandTools();

  test("all tools have required pi fields: name, description, parameters, execute", () => {
    for (const tool of tools) {
      expect(tool.name).toBeString();
      expect(tool.description).toBeString();
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.execute).toBe("function");
      expect((tool as any).inputSchema).toBeUndefined();
    }
  });

  test("parameters are valid JSON Schema objects with type 'object'", () => {
    for (const tool of tools) {
      expect(tool.parameters.type).toBe("object");
      expect(tool.parameters).toHaveProperty("properties");
    }
  });

  test("6 tools are defined", () => {
    expect(tools).toHaveLength(6);
    expect(tools.map(t => t.name)).toEqual([
      "create_github_issue",
      "get_github_issue",
      "update_github_issue",
      "update_check_run",
      "comment_on_pr",
      "get_review_context",
    ]);
  });

  test("execute returns pi MCP-style result: { content: [{ type, text }], details: {} }", async () => {
    for (const tool of tools) {
      const result = await tool.execute("test-call-id", { title: "t", body: "b", conclusion: "success", summary: "s" });
      expect(result).toHaveProperty("content");
      expect(result).toHaveProperty("details");
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content[0]).toHaveProperty("type", "text");
      expect(result.content[0]).toHaveProperty("text");
      expect(typeof result.content[0].text).toBe("string");
    }
  });

  test("execute accepts (toolCallId, params) signature", async () => {
    const createIssue = tools.find(t => t.name === "create_github_issue")!;
    const result = await createIssue.execute("call-123", { title: "Test Issue", body: "test" });
    expect(result.content[0].text).toContain("Test Issue");
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

  test("get_review_context has no required params", () => {
    const tool = tools.find(t => t.name === "get_review_context")!;
    expect(tool.parameters.required ?? []).toHaveLength(0);
  });
});
