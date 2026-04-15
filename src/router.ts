import type { BotuaConfig } from "./config";
import type { JobQueue } from "./queue";
import { handlePRReview } from "./handlers/pr-review";
import { findInstallation, getInstallationToken, addReaction } from "./github";

export interface WebhookContext {
  source: "github" | "gitea";
  eventType: string;
  payload: any;
  deliveryId?: string;
  config: BotuaConfig;
  queue: JobQueue;
}

export interface RouteResult {
  jobId?: string;
  action?: string;
  skipped?: string;
}

export async function routeEvent(ctx: WebhookContext): Promise<RouteResult | null> {
  const { source, eventType, payload } = ctx;

  if (source === "github") {
    return routeGitHubEvent(ctx);
  }

  if (source === "gitea") {
    return routeGiteaEvent(ctx);
  }

  return null;
}

function routeGitHubEvent(ctx: WebhookContext): Promise<RouteResult | null> {
  const { eventType, payload } = ctx;

  switch (eventType) {
    case "pull_request.opened":
    case "pull_request.synchronize":
      return handlePRReview(ctx);

    case "issue_comment.created":
      return handleMention(ctx);

    case "pull_request_review_comment.created":
      return handleMention(ctx);

    case "ping":
      console.log(`[router] github ping: ${payload.zen}`);
      return Promise.resolve({ action: "pong" });

    default:
      return Promise.resolve(null);
  }
}

function routeGiteaEvent(ctx: WebhookContext): Promise<RouteResult | null> {
  const { eventType } = ctx;

  // Gitea webhook support — same events, different header names
  switch (eventType) {
    case "pull_request.opened":
    case "pull_request.synchronized":
      return handlePRReview(ctx);

    case "issue_comment.created":
      return handleMention(ctx);

    default:
      return Promise.resolve(null);
  }
}

async function handleMention(ctx: WebhookContext): Promise<RouteResult | null> {
  const { payload, config } = ctx;
  const comment = payload.comment?.body ?? "";

  // Only handle @botua mentions
  if (!comment.includes("@botua")) {
    return { skipped: "no @botua mention" };
  }

  const repo = payload.repository?.full_name;
  const prNumber = payload.issue?.number ?? payload.pull_request?.number;
  const commentId = payload.comment?.id;
  const command = extractCommand(comment);

  console.log(`[router] @botua command: "${command}" on ${repo}#${prNumber}`);

  // Handle re-review command — force a new review even if already reviewed
  if (/^re-?review$/i.test(command) || command === "review") {
    await reactToComment(config, repo, commentId, "rocket");
    return handlePRReview({ ...ctx, payload: { ...payload, _force_review: true } });
  }

  // For any other @botua mention — acknowledge with 👀 reaction.
  // The comment itself becomes context for the next review (via PR comment fetching).
  // No job needed — the user's message is already stored in the PR thread.
  await reactToComment(config, repo, commentId, "eyes");

  console.log(`[router] acknowledged @botua mention on ${repo}#${prNumber}: "${command}"`);
  return { action: "acknowledged", skipped: "message noted — will be included in next review context" };
}

/** React to a comment on GitHub */
async function reactToComment(config: BotuaConfig, repo: string, commentId: number, reaction: string): Promise<void> {
  if (!repo || !commentId || !config.github.app_id) return;
  try {
    const [owner, repoName] = repo.split("/");
    const installationId = await findInstallation(config, owner, repoName);
    const token = await getInstallationToken(config, installationId);
    await addReaction(token, owner, repoName, commentId, reaction);
  } catch (err: any) {
    console.error(`[router] failed to react to comment:`, err.message);
  }
}

function extractCommand(comment: string): string {
  // Extract everything after @botua
  const match = comment.match(/@botua\s+([\s\S]*)/i);
  if (!match) return comment;
  // Take first line after @botua as the command
  return match[1].split("\n")[0].trim();
}
