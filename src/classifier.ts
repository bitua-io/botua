/**
 * Persistent comment classifier.
 *
 * Stays alive as a Bun Worker for the service lifetime.
 * Classifies PR comments to decide if botua should act on them.
 * Uses a lightweight pi session — no tools, just text classification.
 */

import { createModelSetup } from "./models";
import {
  createAgentSession,
  SessionManager,
} from "@mariozechner/pi-coding-agent";

export interface ClassifyRequest {
  type: "classify";
  id: string;
  comment: string;
  commentAuthor: string;
  reviewBody: string;      // the last botua review on this PR
  checkConclusion: string;  // current check run conclusion
}

export interface ClassifyResponse {
  type: "classification";
  id: string;
  relevant: boolean;
  intent?: "acknowledge" | "question" | "request_action" | "disagree" | "unrelated";
  confidence: number;
  reason?: string;
}

const SYSTEM_PROMPT = `You are a classifier for a PR review bot called Botua. Your ONLY job is to classify comments on pull requests.

Given:
- The bot's review of the PR
- A new comment on the PR
- The current check status

Respond with ONLY a JSON object (no markdown, no explanation):
{
  "relevant": true/false,     // is this comment about the bot's review or review findings?
  "intent": "...",            // one of: "acknowledge", "question", "request_action", "disagree", "unrelated"
  "confidence": 0.0-1.0,     // how confident you are
  "reason": "..."            // brief explanation (one sentence)
}

Intent definitions:
- "acknowledge": user accepts or explains away a review finding (e.g., "will fix in next PR", "this is a false positive", "out of scope")
- "question": user asks about a review finding (e.g., "what do you mean by X?", "can you explain?")
- "request_action": user asks the bot to do something (e.g., "create an issue", "approve this", "re-review")
- "disagree": user pushes back on a finding (e.g., "this is wrong", "that's not a bug")
- "unrelated": comment is not about the review (general PR discussion, CI, unrelated topics)

Rules:
- Comments from the bot itself are ALWAYS unrelated (don't classify our own messages)
- If the commenter is discussing code changes without referencing the review, it's unrelated
- Be conservative — when unsure, classify as unrelated with low confidence
- Comments mentioning specific files, patterns, or issues from the review are likely relevant`;

let modelSetup: ReturnType<typeof createModelSetup> | null = null;

function getModelSetup() {
  if (!modelSetup) {
    const kimiApiKey = process.env.KIMI_API_KEY ?? "";
    const provider = process.env.AI_PROVIDER ?? "kimi-coding";
    const model = process.env.AI_MODEL ?? "k2p5";
    modelSetup = createModelSetup({ provider, model, kimiApiKey });
  }
  return modelSetup;
}

declare var self: Worker;

self.onmessage = async (event: MessageEvent<ClassifyRequest>) => {
  const req = event.data;
  if (req.type !== "classify") return;

  try {
    const setup = getModelSetup();

    const { session } = await createAgentSession({
      cwd: process.cwd(),
      model: setup.model,
      modelRegistry: setup.modelRegistry,
      authStorage: setup.authStorage,
      tools: [],
      customTools: [],
      sessionManager: SessionManager.inMemory(),
      systemPrompt: SYSTEM_PROMPT,
    });

    // Truncate review to keep prompt small
    const reviewSummary = req.reviewBody.length > 1000
      ? req.reviewBody.slice(0, 1000) + "\n... (truncated)"
      : req.reviewBody;

    const prompt = `## Botua's Review (check: ${req.checkConclusion})
${reviewSummary}

## New Comment by @${req.commentAuthor}
${req.comment}

Classify this comment. Respond with JSON only.`;

    await session.prompt(prompt);
    const output = session.getLastAssistantText?.() ?? "";

    // Parse the JSON response
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const response: ClassifyResponse = {
        type: "classification",
        id: req.id,
        relevant: parsed.relevant ?? false,
        intent: parsed.intent ?? "unrelated",
        confidence: parsed.confidence ?? 0,
        reason: parsed.reason,
      };
      self.postMessage(response);
    } else {
      self.postMessage({
        type: "classification",
        id: req.id,
        relevant: false,
        intent: "unrelated",
        confidence: 0,
        reason: "Failed to parse classifier output",
      } satisfies ClassifyResponse);
    }
  } catch (err: any) {
    self.postMessage({
      type: "classification",
      id: req.id,
      relevant: false,
      intent: "unrelated",
      confidence: 0,
      reason: `Classifier error: ${err.message}`,
    } satisfies ClassifyResponse);
  }
};

console.log("[classifier] worker started");
