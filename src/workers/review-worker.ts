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

    // Build the review prompt
    const diff = payload.diff ?? "";
    const memoriesContext = memories.length > 0
      ? `\n\nPrevious context about this repo:\n${memories.map(m => `- [${m.category}] ${m.content}`).join("\n")}\n`
      : "";

    const prompt = [
      "Review this pull request.",
      "",
      `Title: ${prData.title}`,
      `Description: ${prData.body || "(no description)"}`,
      `Author: ${prData.author}`,
      `Branch: ${prData.headBranch} → ${prData.baseBranch}`,
      `Changed files: ${prData.changedFiles.join(", ")}`,
      memoriesContext,
      diff ? `\nDiff:\n\`\`\`diff\n${diff}\n\`\`\`` : "",
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
