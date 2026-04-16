import type { BotuaConfig } from "./config";
import type { JobQueue } from "./queue";
import { handlePRReview } from "./handlers/pr-review";
import { findInstallation, getInstallationToken, addReaction } from "./github";
import type { ClassifyRequest, ClassifyResponse } from "./classifier";

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

// Persistent classifier worker — stays alive for the service lifetime
let classifierWorker: Worker | null = null;
const pendingClassifications = new Map<string, (result: ClassifyResponse) => void>();

function getClassifier(): Worker {
  if (!classifierWorker) {
    classifierWorker = new Worker(new URL("./classifier.ts", import.meta.url).href);
    classifierWorker.onmessage = (event: MessageEvent<ClassifyResponse>) => {
      const resolve = pendingClassifications.get(event.data.id);
      if (resolve) {
        pendingClassifications.delete(event.data.id);
        resolve(event.data);
      }
    };
    classifierWorker.onerror = (err) => {
      console.error("[classifier] worker error:", err.message);
    };
  }
  return classifierWorker;
}

function classify(req: Omit<ClassifyRequest, "type" | "id">): Promise<ClassifyResponse> {
  const id = crypto.randomUUID();
  const worker = getClassifier();
  return new Promise((resolve) => {
    // Timeout after 30s
    const timeout = setTimeout(() => {
      pendingClassifications.delete(id);
      resolve({ type: "classification", id, relevant: false, intent: "unrelated", confidence: 0, reason: "timeout" });
    }, 30_000);

    pendingClassifications.set(id, (result) => {
      clearTimeout(timeout);
      resolve(result);
    });

    worker.postMessage({ type: "classify", id, ...req } satisfies ClassifyRequest);
  });
}

export async function routeEvent(ctx: WebhookContext): Promise<RouteResult | null> {
  const { source, eventType } = ctx;

  if (source === "github") return routeGitHubEvent(ctx);
  if (source === "gitea") return routeGiteaEvent(ctx);
  return null;
}

function routeGitHubEvent(ctx: WebhookContext): Promise<RouteResult | null> {
  const { eventType, payload } = ctx;

  switch (eventType) {
    case "pull_request.opened":
    case "pull_request.synchronize":
      return handlePRReview(ctx);

    case "issue_comment.created":
    case "pull_request_review_comment.created":
      return handleComment(ctx);

    case "ping":
      console.log(`[router] github ping: ${payload.zen}`);
      return Promise.resolve({ action: "pong" });

    default:
      return Promise.resolve(null);
  }
}

function routeGiteaEvent(ctx: WebhookContext): Promise<RouteResult | null> {
  const { eventType } = ctx;

  switch (eventType) {
    case "pull_request.opened":
    case "pull_request.synchronized":
      return handlePRReview(ctx);

    case "issue_comment.created":
      return handleComment(ctx);

    default:
      return Promise.resolve(null);
  }
}

/**
 * Handle any comment on a PR.
 *
 * Two paths:
 * 1. Explicit @botua mention → direct command (fast path)
 * 2. No mention → check if PR has botua review → classify → maybe act
 */
async function handleComment(ctx: WebhookContext): Promise<RouteResult | null> {
  const { payload, config } = ctx;
  const comment = payload.comment?.body ?? "";
  const commentAuthor = payload.comment?.user?.login ?? payload.sender?.login ?? "";
  const commentAuthorType = payload.comment?.user?.type ?? "";
  const repo = payload.repository?.full_name;
  const prNumber = payload.issue?.number ?? payload.pull_request?.number;
  const commentId = payload.comment?.id;

  // Skip bot comments (don't classify our own messages)
  if (commentAuthorType === "Bot" || commentAuthor.endsWith("[bot]")) {
    return null;
  }

  // Skip if not a PR (issues don't have pull_request field)
  if (!payload.issue?.pull_request && !payload.pull_request) {
    return null;
  }

  // Strip quoted lines (> ...) to avoid matching @botua inside quotes
  const unquotedComment = stripQuotedLines(comment);

  // Path 1: Explicit @botua mention in the actual (non-quoted) text → direct command
  if (unquotedComment.includes("@botua")) {
    return handleDirectMention(ctx, comment, unquotedComment, repo, prNumber, commentId, commentAuthor);
  }

  // Path 2: No mention → check if PR has a botua review, then classify
  return handlePassiveClassification(ctx, comment, repo, prNumber, commentId, commentAuthor);
}

/** Handle explicit @botua mentions — fast path, always acts */
async function handleDirectMention(
  ctx: WebhookContext,
  fullComment: string,
  unquotedComment: string,
  repo: string,
  prNumber: number,
  commentId: number,
  commentAuthor: string,
): Promise<RouteResult> {
  const { config } = ctx;
  const command = extractCommand(unquotedComment);

  console.log(`[router] @botua command: "${command}" on ${repo}#${prNumber}`);

  // Handle re-review command
  if (/^re-?review$/i.test(command) || command === "review") {
    await reactToComment(config, repo, commentId, "rocket");
    return handlePRReview({ ...ctx, payload: { ...ctx.payload, _force_review: true } });
  }

  // React and queue command job
  await reactToComment(config, repo, commentId, "eyes");
  return queueCommandJob(ctx, repo, prNumber, commentId, fullComment, command, commentAuthor);
}

/** Handle non-mentioned comments — classify first, only act if relevant */
async function handlePassiveClassification(
  ctx: WebhookContext,
  comment: string,
  repo: string,
  prNumber: number,
  commentId: number,
  commentAuthor: string,
): Promise<RouteResult | null> {
  const { config } = ctx;

  // Quick check: does this PR have a botua review? (check the queue for completed review jobs)
  const hasReview = ctx.queue.hasCompletedReviewForPR(repo, prNumber);
  if (!hasReview) {
    return null; // No botua review on this PR — ignore
  }

  // Fetch the latest botua review to provide context to the classifier
  let reviewBody = "";
  let checkConclusion = "";
  try {
    const [owner, repoName] = repo.split("/");
    const token = await getToken(config, owner, repoName);
    if (token) {
      // Get latest botua comment
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repoName}/issues/${prNumber}/comments?per_page=100`,
        { headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json" } },
      );
      if (res.ok) {
        const comments = await res.json();
        const botuaComment = [...comments].reverse().find((c: any) => c.body?.includes("<!-- botua -->"));
        if (botuaComment) reviewBody = botuaComment.body;
      }

      // Get check run conclusion
      const prRes = await fetch(
        `https://api.github.com/repos/${owner}/${repoName}/pulls/${prNumber}`,
        { headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json" } },
      );
      if (prRes.ok) {
        const prData = await prRes.json();
        const headSha = prData.head?.sha;
        if (headSha) {
          const checksRes = await fetch(
            `https://api.github.com/repos/${owner}/${repoName}/commits/${headSha}/check-runs`,
            { headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json" } },
          );
          if (checksRes.ok) {
            const checksData = await checksRes.json();
            const botuaCheck = checksData.check_runs?.find((r: any) => r.name === "Botua");
            if (botuaCheck) checkConclusion = botuaCheck.conclusion ?? "pending";
          }
        }
      }
    }
  } catch (err: any) {
    console.error(`[router] failed to fetch review context:`, err.message);
  }

  if (!reviewBody) {
    return null; // No botua review found — skip classification
  }

  // Classify the comment
  console.log(`[router] classifying comment by @${commentAuthor} on ${repo}#${prNumber}`);

  const result = await classify({
    comment,
    commentAuthor,
    reviewBody,
    checkConclusion,
  });

  console.log(`[router] classification: relevant=${result.relevant} intent=${result.intent} confidence=${result.confidence} reason="${result.reason}"`);

  // Only act on relevant comments with sufficient confidence
  if (!result.relevant || result.confidence < 0.6 || result.intent === "unrelated") {
    return { skipped: `classifier: ${result.intent} (${result.confidence})` };
  }

  // Relevant comment detected — react and queue command job
  await reactToComment(config, repo, commentId, "eyes");
  return queueCommandJob(ctx, repo, prNumber, commentId, comment, comment, commentAuthor);
}

/** Queue a command job for the command worker to process */
async function queueCommandJob(
  ctx: WebhookContext,
  repo: string,
  prNumber: number,
  commentId: number,
  commentBody: string,
  command: string,
  user: string,
): Promise<RouteResult> {
  const { config } = ctx;

  // Get head SHA for check run lookup
  let headSha: string | undefined;
  try {
    const [owner, repoName] = repo.split("/");
    const token = await getToken(config, owner, repoName);
    if (token) {
      const prRes = await fetch(
        `https://api.github.com/repos/${owner}/${repoName}/pulls/${prNumber}`,
        { headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json" } },
      );
      if (prRes.ok) {
        const prData = await prRes.json();
        headSha = prData.head?.sha;
      }
    }
  } catch {}

  const jobId = ctx.queue.createJob({
    repo,
    type: "pr-command",
    payload: {
      pr_number: prNumber,
      command,
      comment_id: commentId,
      comment_body: commentBody,
      user,
      head_sha: headSha,
    },
  });

  return { jobId, action: "pr-command" };
}

/** Get an installation token for a repo */
async function getToken(config: BotuaConfig, owner: string, repoName: string): Promise<string | null> {
  if (!config.github.app_id) return process.env.GITHUB_TOKEN ?? null;
  try {
    const installationId = await findInstallation(config, owner, repoName);
    return await getInstallationToken(config, installationId);
  } catch {
    return null;
  }
}

/** React to a comment on GitHub */
async function reactToComment(config: BotuaConfig, repo: string, commentId: number, reaction: string): Promise<void> {
  if (!repo || !commentId || !config.github.app_id) return;
  try {
    const [owner, repoName] = repo.split("/");
    const token = await getToken(config, owner, repoName);
    if (token) await addReaction(token, owner, repoName, commentId, reaction);
  } catch (err: any) {
    console.error(`[router] failed to react to comment:`, err.message);
  }
}

/** Strip GitHub-style quoted lines (> ...) from a comment */
function stripQuotedLines(comment: string): string {
  return comment
    .split("\n")
    .filter(line => !line.trimStart().startsWith(">"))
    .join("\n")
    .trim();
}

function extractCommand(comment: string): string {
  const match = comment.match(/@botua[\w-]*\s+([\s\S]*)/i);
  if (!match) return comment;
  return match[1].split("\n")[0].trim();
}
