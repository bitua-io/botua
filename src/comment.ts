import { parseArgs } from "util";
import type { ReviewVerdict } from "./types";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    repo: { type: "string" },
    pr: { type: "string" },
    "verdict-json": { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
  strict: true,
});

if (!values.repo || !values.pr || !values["verdict-json"]) {
  console.error(
    "Usage: bun run src/comment.ts --repo owner/repo --pr 123 --verdict-json <file> [--dry-run]",
  );
  process.exit(1);
}

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error("GITHUB_TOKEN env var required");
  process.exit(1);
}

const [owner, repo] = values.repo.split("/");
const prNumber = parseInt(values.pr!);
const verdict: ReviewVerdict = JSON.parse(await Bun.file(values["verdict-json"]!).text());

const MARKER = "<!-- botua -->";
const body = formatComment(verdict);

if (values["dry-run"]) {
  console.log("=== DRY RUN — would post/update comment: ===\n");
  console.log(body);
  process.exit(0);
}

// Find existing botua comment
const existingId = await findExistingComment();

if (existingId) {
  await updateComment(existingId, body);
  console.error(`[comment] Updated existing comment ${existingId}`);
} else {
  const newId = await createComment(body);
  console.error(`[comment] Created new comment ${newId}`);
}

// --- helpers ---

function formatComment(v: ReviewVerdict): string {
  const icon = v.approved ? "✅" : "❌";
  const status = v.approved ? "Approved" : "Changes Requested";

  let md = `${MARKER}\n`;
  md += `## ${icon} Botua — ${status}\n\n`;
  md += v.raw;
  md += `\n\n---\n*Reviewed by Botua (Kimi K2.5)*`;

  return md;
}

async function findExistingComment(): Promise<number | null> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`,
    {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
      },
    },
  );
  if (!res.ok) return null;
  const comments = await res.json();
  const existing = comments.find((c: any) => c.body?.startsWith(MARKER));
  return existing ? existing.id : null;
}

async function updateComment(commentId: number, body: string): Promise<void> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/comments/${commentId}`,
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
  if (!res.ok) {
    console.error(`Failed to update comment: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
}

async function createComment(body: string): Promise<number> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`,
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
    console.error(`Failed to create comment: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const data = await res.json();
  return data.id;
}
