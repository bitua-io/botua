import { parseArgs } from "util";
import type { PRInfo } from "./types";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    repo: { type: "string" },
    pr: { type: "string" },
    "diff-only": { type: "boolean", default: false },
  },
  strict: true,
});

if (!values.repo || !values.pr) {
  console.error("Usage: bun run src/fetch-pr.ts --repo owner/repo --pr 123 [--diff-only]");
  process.exit(1);
}

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error("GITHUB_TOKEN env var required");
  process.exit(1);
}

const [owner, repo] = values.repo.split("/");
const prNumber = parseInt(values.pr);
const headers = {
  Authorization: `token ${token}`,
  Accept: "application/vnd.github+json",
};

async function fetchJSON(url: string) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    console.error(`GitHub API error: ${res.status} ${res.statusText} for ${url}`);
    process.exit(1);
  }
  return res.json();
}

async function fetchDiff(): Promise<string> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
    { headers: { ...headers, Accept: "application/vnd.github.diff" } }
  );
  if (!res.ok) {
    console.error(`Failed to fetch diff: ${res.status}`);
    process.exit(1);
  }
  return res.text();
}

// Fetch PR metadata
const pr = await fetchJSON(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`);

// Fetch diff
const diff = await fetchDiff();

if (values["diff-only"]) {
  console.log(diff);
  process.exit(0);
}

// Fetch changed files
const files = await fetchJSON(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`);

const prInfo: PRInfo = {
  owner,
  repo,
  number: prNumber,
  title: pr.title,
  body: pr.body || "",
  author: pr.user.login,
  labels: (pr.labels || []).map((l: any) => l.name),
  baseBranch: pr.base.ref,
  headBranch: pr.head.ref,
  headSha: pr.head.sha,
  diff,
  changedFiles: files.map((f: any) => f.filename),
};

console.log(JSON.stringify(prInfo, null, 2));
