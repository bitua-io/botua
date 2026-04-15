/**
 * GitHub App client — JWT auth, installation tokens, check runs, comments.
 * All using native fetch(), no octokit.
 */

import { createSign } from "crypto";
import type { BotuaConfig } from "./config";

const API = "https://api.github.com";

// Cache installation tokens (they last 1 hour, we refresh at 50 min)
const tokenCache = new Map<number, { token: string; expiresAt: number }>();

/** Generate a JWT for the GitHub App */
async function generateJWT(config: BotuaConfig): Promise<string> {
  if (!config.github.app_id || !config.github.private_key_path) {
    throw new Error("GitHub App not configured (missing app_id or private_key_path)");
  }

  const privateKeyPem = await Bun.file(config.github.private_key_path).text();
  const now = Math.floor(Date.now() / 1000);

  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iat: now - 60,
    exp: now + (10 * 60),
    iss: config.github.app_id,
  })).toString("base64url");

  const sign = createSign("RSA-SHA256");
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(privateKeyPem, "base64url");

  return `${header}.${payload}.${signature}`;
}

/** Get an installation token for a repo */
export async function getInstallationToken(
  config: BotuaConfig,
  installationId: number,
): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const jwt = await generateJWT(config);
  const res = await fetch(
    `${API}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
      },
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to get installation token: ${res.status} ${text}`);
  }

  const data = await res.json();
  const token = data.token;
  // Cache with 50 minute expiry (tokens last 1 hour)
  tokenCache.set(installationId, {
    token,
    expiresAt: Date.now() + 50 * 60 * 1000,
  });

  return token;
}

/** Find the installation ID for a given repo */
export async function findInstallation(
  config: BotuaConfig,
  owner: string,
  repo: string,
): Promise<number> {
  const jwt = await generateJWT(config);
  const res = await fetch(
    `${API}/repos/${owner}/${repo}/installation`,
    {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
      },
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`No installation found for ${owner}/${repo}: ${res.status} ${text}`);
  }

  const data = await res.json();
  return data.id;
}

/** Create or update a check run on a commit */
export async function createCheckRun(
  token: string,
  owner: string,
  repo: string,
  params: {
    name: string;
    head_sha: string;
    status: "queued" | "in_progress" | "completed";
    conclusion?: "success" | "failure" | "action_required";
    output?: { title: string; summary: string };
  },
): Promise<number> {
  const body: any = {
    name: params.name,
    head_sha: params.head_sha,
    status: params.status,
  };
  if (params.conclusion) body.conclusion = params.conclusion;
  if (params.output) body.output = params.output;
  if (params.status === "in_progress") body.started_at = new Date().toISOString();
  if (params.status === "completed") body.completed_at = new Date().toISOString();

  const res = await fetch(`${API}/repos/${owner}/${repo}/check-runs`, {
    method: "POST",
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to create check run: ${res.status} ${text}`);
  }

  const data = await res.json();
  return data.id;
}

/** Update an existing check run by ID */
export async function updateCheckRun(
  token: string,
  owner: string,
  repo: string,
  checkRunId: number,
  params: {
    status?: "queued" | "in_progress" | "completed";
    conclusion?: "success" | "failure" | "action_required";
    output?: { title: string; summary: string };
  },
): Promise<void> {
  const body: any = {};
  if (params.status) body.status = params.status;
  if (params.conclusion) body.conclusion = params.conclusion;
  if (params.output) body.output = params.output;
  if (params.status === "completed") body.completed_at = new Date().toISOString();

  const res = await fetch(`${API}/repos/${owner}/${repo}/check-runs/${checkRunId}`, {
    method: "PATCH",
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to update check run ${checkRunId}: ${res.status} ${text}`);
  }
}

/** Post or update a comment on a PR/issue */
export async function postComment(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
  marker?: string,
): Promise<number> {
  // If marker provided, find and update existing comment
  if (marker) {
    const existingId = await findCommentByMarker(token, owner, repo, issueNumber, marker);
    if (existingId) {
      await updateComment(token, owner, repo, existingId, body);
      return existingId;
    }
  }

  const res = await fetch(
    `${API}/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    {
      method: "POST",
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body }),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to post comment: ${res.status} ${text}`);
  }

  const data = await res.json();
  return data.id;
}

async function findCommentByMarker(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  marker: string,
): Promise<number | null> {
  const res = await fetch(
    `${API}/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`,
    {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
      },
    },
  );
  if (!res.ok) return null;
  const comments = await res.json();
  const existing = comments.find((c: any) => c.body?.includes(marker));
  return existing?.id ?? null;
}

async function updateComment(
  token: string,
  owner: string,
  repo: string,
  commentId: number,
  body: string,
): Promise<void> {
  await fetch(
    `${API}/repos/${owner}/${repo}/issues/comments/${commentId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body }),
    },
  );
}

/** Add a reaction to a comment */
export async function addReaction(
  token: string,
  owner: string,
  repo: string,
  commentId: number,
  reaction: string,
): Promise<void> {
  await fetch(
    `${API}/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`,
    {
      method: "POST",
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: reaction }),
    },
  );
}

/** Fetch comments on a PR/issue */
export async function fetchPRComments(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<Array<{ author: string; body: string; created_at: string; is_bot: boolean }>> {
  const res = await fetch(
    `${API}/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`,
    {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
      },
    },
  );
  if (!res.ok) return [];
  const comments = await res.json();
  return comments.map((c: any) => ({
    author: c.user?.login ?? "unknown",
    body: c.body ?? "",
    created_at: c.created_at,
    is_bot: c.user?.type === "Bot" || c.performed_via_github_app != null,
  }));
}

/** Fetch PR diff from GitHub */
export async function fetchPRDiff(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<string> {
  const res = await fetch(
    `${API}/repos/${owner}/${repo}/pulls/${prNumber}`,
    {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github.diff",
      },
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch PR diff: ${res.status}`);
  }
  return res.text();
}

