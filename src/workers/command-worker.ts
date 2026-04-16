/**
 * Bun Worker — PR Command Handler
 *
 * Handles @botua mentions on PRs. Uses a lightweight AI agent to understand
 * the user's intent and take actions (create issues, update check runs, reply).
 */

import type { InitMessage, WorkerMessage } from "./protocol";
import { createModelSetup } from "../models";
import {
  createAgentSession,
  createReadOnlyTools,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";

declare var self: Worker;

function send(msg: WorkerMessage) {
  self.postMessage(msg);
}

/** Helper to return pi-compatible tool result */
function toolResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

self.onmessage = async (event: MessageEvent<InitMessage>) => {
  const msg = event.data;
  if (msg.type !== "init") return;

  const { jobId, repo, payload, githubToken, kimiApiKey, config: jobConfig } = msg;

  try {
    send({ type: "progress", jobId, step: "Analyzing command" });

    const { modelRegistry, authStorage, model } = createModelSetup({
      provider: jobConfig.provider,
      model: jobConfig.model,
      kimiApiKey,
    });

    const [owner, repoName] = repo.split("/");
    const API = "https://api.github.com";
    const apiHeaders = {
      Authorization: `token ${githubToken}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    };

    // Custom tools for the command agent — pi execute signature:
    // execute(toolCallId, params, signal?, onUpdate?, ctx?) → { content: [...], details: {} }
    const commandTools = [
      {
        name: "create_github_issue",
        description: "Create a new issue on the repository. Use this when the user asks to create an issue, track something, or file a follow-up task.",
        parameters: Type.Object({
          title: Type.String({ description: "Issue title" }),
          body: Type.String({ description: "Issue body in markdown" }),
          labels: Type.Optional(Type.Array(Type.String(), { description: "Labels to add" })),
          assignees: Type.Optional(Type.Array(Type.String(), { description: "GitHub usernames to assign" })),
        }),
        async execute(_id: string, params: any) {
          const res = await fetch(`${API}/repos/${owner}/${repoName}/issues`, {
            method: "POST",
            headers: apiHeaders,
            body: JSON.stringify({
              title: params.title,
              body: params.body,
              labels: params.labels ?? [],
              assignees: params.assignees ?? [],
            }),
          });
          if (!res.ok) {
            const text = await res.text();
            return toolResult(`Failed to create issue: ${res.status} ${text}`);
          }
          const issue = await res.json();
          return toolResult(`Created issue #${issue.number}: ${issue.html_url}`);
        },
      },
      {
        name: "get_github_issue",
        description: "Read an existing issue by number. Use this to see the current content before updating it.",
        parameters: Type.Object({
          issue_number: Type.Number({ description: "Issue number" }),
        }),
        async execute(_id: string, params: any) {
          const res = await fetch(`${API}/repos/${owner}/${repoName}/issues/${params.issue_number}`, {
            headers: apiHeaders,
          });
          if (!res.ok) return toolResult(`Issue #${params.issue_number} not found: ${res.status}`);
          const issue = await res.json();
          return toolResult(JSON.stringify({
            number: issue.number,
            title: issue.title,
            body: issue.body,
            state: issue.state,
            labels: issue.labels?.map((l: any) => l.name) ?? [],
            assignees: issue.assignees?.map((a: any) => a.login) ?? [],
            html_url: issue.html_url,
          }, null, 2));
        },
      },
      {
        name: "update_github_issue",
        description: "Update an existing issue's title, body, labels, or state. Use this to add context, close issues, or modify existing ones.",
        parameters: Type.Object({
          issue_number: Type.Number({ description: "Issue number to update" }),
          title: Type.Optional(Type.String({ description: "New title (omit to keep current)" })),
          body: Type.Optional(Type.String({ description: "New body in markdown (omit to keep current)" })),
          state: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("closed")], { description: "New state" })),
          labels: Type.Optional(Type.Array(Type.String(), { description: "Replace labels" })),
        }),
        async execute(_id: string, params: any) {
          const update: any = {};
          if (params.title) update.title = params.title;
          if (params.body) update.body = params.body;
          if (params.state) update.state = params.state;
          if (params.labels) update.labels = params.labels;

          const res = await fetch(`${API}/repos/${owner}/${repoName}/issues/${params.issue_number}`, {
            method: "PATCH",
            headers: apiHeaders,
            body: JSON.stringify(update),
          });
          if (!res.ok) {
            const text = await res.text();
            return toolResult(`Failed to update issue #${params.issue_number}: ${res.status} ${text}`);
          }
          return toolResult(`Updated issue #${params.issue_number}`);
        },
      },
      {
        name: "update_check_run",
        description: "Update the Botua check run on this PR. Use this to change the conclusion (e.g., from 'action_required' to 'success') when the user acknowledges all review issues.",
        parameters: Type.Object({
          conclusion: Type.Union([
            Type.Literal("success"),
            Type.Literal("action_required"),
            Type.Literal("failure"),
          ], { description: "New conclusion for the check run" }),
          summary: Type.String({ description: "Updated summary explaining the change" }),
        }),
        async execute(_id: string, params: any) {
          // Find the latest Botua check run on this PR
          const headSha = payload.head_sha;
          if (!headSha) return toolResult("No check run found — missing head_sha");

          const res = await fetch(`${API}/repos/${owner}/${repoName}/commits/${headSha}/check-runs`, {
            headers: apiHeaders,
          });
          if (!res.ok) return toolResult(`Failed to find check runs: ${res.status}`);
          const data = await res.json();
          const botuaRun = data.check_runs?.find((r: any) => r.name === "Botua");
          if (!botuaRun) return toolResult("No Botua check run found on this commit");

          const updateRes = await fetch(`${API}/repos/${owner}/${repoName}/check-runs/${botuaRun.id}`, {
            method: "PATCH",
            headers: apiHeaders,
            body: JSON.stringify({
              status: "completed",
              conclusion: params.conclusion,
              completed_at: new Date().toISOString(),
              output: {
                title: params.conclusion === "success" ? "Botua — Approved" : `Botua — ${params.conclusion}`,
                summary: params.summary,
              },
            }),
          });
          if (!updateRes.ok) return toolResult(`Failed to update check run: ${updateRes.status}`);
          return toolResult(`Updated check run to ${params.conclusion}`);
        },
      },
      {
        name: "comment_on_pr",
        description: "Post a comment on the PR explaining what you did.",
        parameters: Type.Object({
          body: Type.String({ description: "Comment body in markdown" }),
        }),
        async execute(_id: string, params: any) {
          const prNumber = payload.pr_number;
          if (!prNumber) return toolResult("No PR number available");

          const res = await fetch(`${API}/repos/${owner}/${repoName}/issues/${prNumber}/comments`, {
            method: "POST",
            headers: apiHeaders,
            body: JSON.stringify({ body: params.body }),
          });
          if (!res.ok) return toolResult(`Failed to post comment: ${res.status}`);
          return toolResult("Comment posted successfully");
        },
      },
      {
        name: "get_review_context",
        description: "Get the latest Botua review and check run status for this PR.",
        parameters: Type.Object({}),
        async execute() {
          const prNumber = payload.pr_number;
          if (!prNumber) return toolResult("No PR number");

          // Get latest botua comment
          const commentsRes = await fetch(`${API}/repos/${owner}/${repoName}/issues/${prNumber}/comments?per_page=100`, { headers: apiHeaders });
          const comments = commentsRes.ok ? await commentsRes.json() : [];
          const botuaComment = [...comments].reverse().find((c: any) => c.body?.includes("<!-- botua -->"));

          // Get check run
          const headSha = payload.head_sha;
          let checkRun = null;
          if (headSha) {
            const checksRes = await fetch(`${API}/repos/${owner}/${repoName}/commits/${headSha}/check-runs`, { headers: apiHeaders });
            if (checksRes.ok) {
              const data = await checksRes.json();
              checkRun = data.check_runs?.find((r: any) => r.name === "Botua");
            }
          }

          return toolResult(JSON.stringify({
            review: botuaComment ? { body: botuaComment.body.slice(0, 2000), updated: botuaComment.updated_at } : null,
            check_run: checkRun ? { id: checkRun.id, conclusion: checkRun.conclusion, title: checkRun.output?.title } : null,
          }, null, 2));
        },
      },
    ];

    send({ type: "progress", jobId, step: "Creating agent session" });

    // Pass built-in tools so pi's tool-calling loop activates
    const builtInTools = createReadOnlyTools(process.cwd());

    const { session } = await createAgentSession({
      cwd: process.cwd(),
      model,
      modelRegistry,
      authStorage,
      tools: builtInTools,
      customTools: commandTools,
      sessionManager: SessionManager.inMemory(),
    });

    // Subscribe to events for debugging
    session.subscribe((event: any) => {
      if (event.type === "tool_execution_end") {
        const toolName = event.toolName ?? event.name ?? "unknown";
        send({ type: "progress", jobId, step: `Tool: ${toolName}` });
      }
    });

    // Build the prompt
    const userComment = payload.command ?? payload.comment_body ?? "";
    const userName = payload.user ?? "unknown";

    const prompt = `You are Botua, a PR review bot for the bitua-io GitHub org. A developer commented on PR #${payload.pr_number} in ${repo}.

**User @${userName} said:**
> ${userComment}

**Your job:**
1. First, use get_review_context to understand what your last review said and the current check run status.
2. Understand what the user is asking and act:
   - **Acknowledge issues**: If they accept review findings ("will fix in next PR", "false positive", "out of scope"), update the check run to "success" with a summary noting which issues were acknowledged and which are deferred.
   - **Create issues**: If they ask you to create an issue, create it with rich context:
     - Reference the PR number: "Raised in PR #${payload.pr_number}"
     - Include the specific review finding that prompted it
     - Quote the relevant code/file if mentioned in the review
     - Use labels if appropriate (e.g., "enhancement", "tech-debt")
   - **Re-review**: If they ask for a re-review, reply that they should use \`@botua review\` to trigger one.
3. Always comment on the PR explaining what you did. Keep it short.

**Rules:**
- Respond in the same language the user wrote in.
- When creating issues, include enough context that someone reading the issue understands the problem without having to find the PR.
- When updating the check to success, only do so if the user has acknowledged ALL outstanding blocking issues (not just one).
- If only some issues are acknowledged, note which ones in your PR comment but don't change the check.`;

    send({ type: "progress", jobId, step: "Processing command" });

    await session.prompt(prompt);

    const output = session.getLastAssistantText?.() ?? "";

    send({
      type: "complete",
      jobId,
      result: { output, command: userComment, user: userName },
    });
  } catch (err: any) {
    send({
      type: "error",
      jobId,
      error: err.message,
      stack: err.stack,
    });
  }
};
