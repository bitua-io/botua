import type { BotuaConfig } from "./config";
import type { JobQueue } from "./queue";
import { handlePRReview } from "./handlers/pr-review";

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
  const { payload } = ctx;
  const comment = payload.comment?.body ?? "";

  // Only handle @botua mentions
  if (!comment.includes("@botua")) {
    return { skipped: "no @botua mention" };
  }

  const repo = payload.repository?.full_name;
  const prNumber = payload.issue?.number ?? payload.pull_request?.number;
  const command = extractCommand(comment);

  console.log(`[router] @botua command: "${command}" on ${repo}#${prNumber}`);

  // Handle re-review command — force a new review even if already reviewed
  if (/^re-?review$/i.test(command) || command === "review") {
    return handlePRReview({ ...ctx, payload: { ...payload, _force_review: true } });
  }

  // Queue an interactive command job
  const jobId = ctx.queue.createJob({
    repo,
    type: "pr-command",
    payload: {
      pr_number: prNumber,
      command,
      comment_id: payload.comment?.id,
      comment_body: comment,
      user: payload.comment?.user?.login ?? payload.sender?.login,
    },
  });

  return { jobId, action: "pr-command" };
}

function extractCommand(comment: string): string {
  // Extract everything after @botua
  const match = comment.match(/@botua\s+([\s\S]*)/i);
  if (!match) return comment;
  // Take first line after @botua as the command
  return match[1].split("\n")[0].trim();
}
