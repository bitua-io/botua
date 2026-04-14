/**
 * Bun Worker — PR Review Agent
 *
 * Runs a pi agent session with read-only tools + custom reviewer tools.
 * Communicates with the main process via postMessage.
 */

import type { InitMessage, WorkerMessage } from "./protocol";
import { createModelSetup } from "../models";
import { createReviewerTools, type PRData } from "../reviewer-tools";
import { parseVerdict } from "../parse-verdict";
import {
  createAgentSession,
  createReadOnlyTools,
  SessionManager,
} from "@mariozechner/pi-coding-agent";

declare var self: Worker;

function send(msg: WorkerMessage) {
  self.postMessage(msg);
}

self.onmessage = async (event: MessageEvent<InitMessage>) => {
  const msg = event.data;
  if (msg.type !== "init") return;

  const { jobId, repo, payload, workDir, githubToken, kimiApiKey, config: jobConfig, memories } = msg;

  try {
    send({ type: "progress", jobId, step: "Initializing agent session" });

    // Set up the model
    const { modelRegistry, authStorage, model } = createModelSetup({
      provider: jobConfig.provider,
      model: jobConfig.model,
      kimiApiKey,
    });

    // Build PR data for tools
    const prData: PRData = {
      title: payload.title ?? "",
      body: payload.body ?? "",
      author: payload.author ?? "",
      baseBranch: payload.base_branch ?? "main",
      headBranch: payload.head_branch ?? "",
      headSha: payload.head_sha ?? "",
      changedFiles: payload.changed_files ?? [],
      labels: payload.labels ?? [],
      owner: repo.split("/")[0],
      repo: repo.split("/")[1],
    };

    // Create tools
    const readOnlyTools = createReadOnlyTools(workDir);
    const reviewerTools = createReviewerTools(
      prData,
      workDir,
      (step) => send({ type: "progress", jobId, step }),
      githubToken,
    );

    send({ type: "progress", jobId, step: "Creating agent session" });

    // Create the agent session
    const { session } = await createAgentSession({
      cwd: workDir,
      model,
      modelRegistry,
      authStorage,
      tools: readOnlyTools,
      customTools: reviewerTools,
      sessionManager: SessionManager.inMemory(),
    });

    // Subscribe to events for progress tracking
    let agentOutput = "";
    session.subscribe((event: any) => {
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        agentOutput += event.assistantMessageEvent.delta;
      }
    });

    // Pre-load changed file contents to reduce tool calls
    send({ type: "progress", jobId, step: "Pre-loading changed files" });
    const fileContents: string[] = [];
    for (const file of prData.changedFiles.slice(0, 20)) { // cap at 20 files
      try {
        const content = await Bun.file(`${workDir}/${file}`).text();
        if (content.length <= 10000) { // skip very large files
          fileContents.push(`### ${file}\n\`\`\`\n${content}\n\`\`\``);
        } else {
          fileContents.push(`### ${file}\n(${content.length} chars — too large to inline, use read tool)`);
        }
      } catch {
        fileContents.push(`### ${file}\n(file not found in worktree)`);
      }
    }

    // Build the review prompt
    const diff = payload.diff ?? "";
    const memoriesContext = memories.length > 0
      ? `\n\nPrevious context about this repo:\n${memories.map(m => `- [${m.category}] ${m.content}`).join("\n")}\n`
      : "";

    const filesSection = fileContents.length > 0
      ? `\n\n## Changed Files (current content)\n\n${fileContents.join("\n\n")}\n`
      : "";

    const prompt = [
      "Review this pull request. The diff and full file contents are provided below — you can start reviewing immediately without reading files. Use tools only if you need additional context (related files, base branch comparison, tests, lint).",
      "",
      `Title: ${prData.title}`,
      `Description: ${prData.body || "(no description)"}`,
      `Author: ${prData.author}`,
      `Branch: ${prData.headBranch} → ${prData.baseBranch}`,
      memoriesContext,
      diff ? `\n## Diff\n\`\`\`diff\n${diff}\n\`\`\`` : "",
      filesSection,
    ].join("\n");

    send({ type: "progress", jobId, step: "Running review" });

    // Run the review
    await session.prompt(prompt);

    send({ type: "progress", jobId, step: "Parsing verdict" });

    // Parse the verdict
    const verdict = parseVerdict(agentOutput);

    send({
      type: "complete",
      jobId,
      result: {
        approved: verdict.approved,
        summary: verdict.summary,
        issues: verdict.issues.length,
        critical: verdict.issues.filter(i => i.severity === "critical").length,
        important: verdict.issues.filter(i => i.severity === "important").length,
        raw: verdict.raw || agentOutput,
        verdict,
      },
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
