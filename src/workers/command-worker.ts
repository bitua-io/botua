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
    const headers = {
      Authorization: `token ${githubToken}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    };

    // Custom tools for the command agent
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
        execute: async (input: { title: string; body: string; labels?: string[]; assignees?: string[] }) => {
          const res = await fetch(`${API}/repos/${owner}/${repoName}/issues`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              title: input.title,
              body: input.body,
              labels: input.labels ?? [],
              assignees: input.assignees ?? [],
            }),
          });
          if (!res.ok) {
            const text = await res.text();
            return `Failed to create issue: ${res.status} ${text}`;
          }
          const issue = await res.json();
          return `Created issue #${issue.number}: ${issue.html_url}`;
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
        execute: async (input: { conclusion: string; summary: string }) => {
          const checkRunId = payload.check_run_id;
          if (!checkRunId) {
            // Find the latest Botua check run on this PR
            const headSha = payload.head_sha;
            if (!headSha) return "No check run found — missing head_sha";

            const res = await fetch(`${API}/repos/${owner}/${repoName}/commits/${headSha}/check-runs`, {
              headers,
            });
            if (!res.ok) return `Failed to find check runs: ${res.status}`;
            const data = await res.json();
            const botuaRun = data.check_runs?.find((r: any) => r.name === "Botua");
            if (!botuaRun) return "No Botua check run found on this commit";

            const updateRes = await fetch(`${API}/repos/${owner}/${repoName}/check-runs/${botuaRun.id}`, {
              method: "PATCH",
              headers,
              body: JSON.stringify({
                status: "completed",
                conclusion: input.conclusion,
                completed_at: new Date().toISOString(),
                output: {
                  title: input.conclusion === "success" ? "Botua — Approved" : `Botua — ${input.conclusion}`,
                  summary: input.summary,
                },
              }),
            });
            if (!updateRes.ok) return `Failed to update check run: ${updateRes.status}`;
            return `Updated check run to ${input.conclusion}`;
          }

          const res = await fetch(`${API}/repos/${owner}/${repoName}/check-runs/${checkRunId}`, {
            method: "PATCH",
            headers,
            body: JSON.stringify({
              status: "completed",
              conclusion: input.conclusion,
              completed_at: new Date().toISOString(),
              output: {
                title: input.conclusion === "success" ? "Botua — Approved" : `Botua — ${input.conclusion}`,
                summary: input.summary,
              },
            }),
          });
          if (!res.ok) return `Failed to update check run: ${res.status}`;
          return `Updated check run to ${input.conclusion}`;
        },
      },
      {
        name: "comment_on_pr",
        description: "Post a comment on the PR explaining what you did.",
        parameters: Type.Object({
          body: Type.String({ description: "Comment body in markdown" }),
        }),
        execute: async (input: { body: string }) => {
          const prNumber = payload.pr_number;
          if (!prNumber) return "No PR number available";

          const res = await fetch(`${API}/repos/${owner}/${repoName}/issues/${prNumber}/comments`, {
            method: "POST",
            headers,
            body: JSON.stringify({ body: input.body }),
          });
          if (!res.ok) return `Failed to post comment: ${res.status}`;
          return "Comment posted";
        },
      },
      {
        name: "get_review_context",
        description: "Get the latest Botua review and check run status for this PR.",
        parameters: Type.Object({}),
        execute: async () => {
          const prNumber = payload.pr_number;
          if (!prNumber) return "No PR number";

          // Get latest botua comment
          const commentsRes = await fetch(`${API}/repos/${owner}/${repoName}/issues/${prNumber}/comments?per_page=100`, { headers });
          const comments = commentsRes.ok ? await commentsRes.json() : [];
          const botuaComment = [...comments].reverse().find((c: any) => c.body?.includes("<!-- botua -->"));

          // Get check run
          const headSha = payload.head_sha;
          let checkRun = null;
          if (headSha) {
            const checksRes = await fetch(`${API}/repos/${owner}/${repoName}/commits/${headSha}/check-runs`, { headers });
            if (checksRes.ok) {
              const data = await checksRes.json();
              checkRun = data.check_runs?.find((r: any) => r.name === "Botua");
            }
          }

          return JSON.stringify({
            review: botuaComment ? { body: botuaComment.body.slice(0, 2000), updated: botuaComment.updated_at } : null,
            check_run: checkRun ? { id: checkRun.id, conclusion: checkRun.conclusion, title: checkRun.output?.title } : null,
          }, null, 2);
        },
      },
    ];

    send({ type: "progress", jobId, step: "Creating agent session" });

    // Pass at least one built-in tool so pi's tool-calling loop activates
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

    const prompt = `You are Botua, a PR review bot for the bitua-io GitHub org. A developer just mentioned you on PR #${payload.pr_number} in ${repo}.

**User @${userName} said:**
> ${userComment}

**Your job:**
1. First, use get_review_context to understand what your last review said and the current check run status.
2. Understand what the user is asking:
   - If they acknowledge review issues (e.g., "will fix in next PR", "false positive", "out of scope"), update the check run to "success" with a summary noting which issues were acknowledged.
   - If they ask you to create an issue, create it with appropriate title, body, and labels.
   - If they ask for a re-review, just reply that they should use "@botua review" to trigger one.
3. Always comment on the PR explaining what you did.

**Rules:**
- Be concise in comments. No long explanations.
- Write issue titles and bodies in the same language the user used.
- If the user writes in Spanish, respond in Spanish.
- If you update the check to success, include a brief note about what was acknowledged.
- Don't update the check to success unless the user has explicitly acknowledged the outstanding issues.`;

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
