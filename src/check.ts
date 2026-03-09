import { parseArgs } from "util";
import type { ReviewVerdict, CheckResult } from "./types";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    repo: { type: "string" },
    sha: { type: "string" },
    "verdict-json": { type: "string" },
    status: { type: "string" }, // "in_progress" | "completed"
    "dry-run": { type: "boolean", default: false },
  },
  strict: true,
});

if (!values.repo || !values.sha) {
  console.error(
    "Usage: bun run src/check.ts --repo owner/repo --sha <commit> [--verdict-json <file>] [--status in_progress] [--dry-run]",
  );
  process.exit(1);
}

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error("GITHUB_TOKEN env var required");
  process.exit(1);
}

const [owner, repo] = values.repo.split("/");
const sha = values.sha!;
const CHECK_NAME = "Pi Review";

// If no verdict, create an in_progress check
if (!values["verdict-json"]) {
  const status = (values.status as string) || "in_progress";
  await createOrUpdateCheck({
    status,
    output: {
      title: "Pi Review — In Progress",
      summary: "Reviewing PR with Kimi K2.5...",
    },
  });
  process.exit(0);
}

// Parse verdict and create completed check
const verdict: ReviewVerdict = JSON.parse(await Bun.file(values["verdict-json"]!).text());
const result = verdictToCheck(verdict);

await createOrUpdateCheck({
  status: "completed",
  conclusion: result.conclusion,
  output: {
    title: result.title,
    summary: result.summary,
  },
});

// --- helpers ---

function verdictToCheck(v: ReviewVerdict): CheckResult {
  const criticalCount = v.issues.filter((i) => i.severity === "critical").length;
  const importantCount = v.issues.filter((i) => i.severity === "important").length;

  let conclusion: CheckResult["conclusion"];
  if (v.approved) {
    conclusion = "success";
  } else if (criticalCount > 0) {
    conclusion = "failure";
  } else {
    conclusion = "action_required";
  }

  const icon = v.approved ? "✅" : "❌";
  const title = v.approved
    ? "Pi Review — Approved"
    : `Pi Review — Changes Requested (${criticalCount} critical, ${importantCount} important)`;

  // Summary is a condensed version for the check run UI
  let summary = v.summary + "\n\n";
  if (v.issues.length > 0) {
    summary += `**Issues found:** ${criticalCount} critical, ${importantCount} important, ${v.issues.length - criticalCount - importantCount} minor\n\n`;
    for (const issue of v.issues.filter((i) => i.severity !== "minor")) {
      summary += `- **[${issue.severity}]** ${issue.file ? `\`${issue.file}\`: ` : ""}${issue.description.split("\n")[0]}\n`;
    }
  } else {
    summary += "No issues found. 🎉";
  }

  return { conclusion, title, summary };
}

async function createOrUpdateCheck(params: {
  status: string;
  conclusion?: string;
  output: { title: string; summary: string };
}): Promise<void> {
  const body: any = {
    name: CHECK_NAME,
    head_sha: sha,
    status: params.status,
    output: params.output,
  };
  if (params.conclusion) body.conclusion = params.conclusion;
  if (params.status === "in_progress") body.started_at = new Date().toISOString();
  if (params.status === "completed") body.completed_at = new Date().toISOString();

  if (values["dry-run"]) {
    console.log("=== DRY RUN — would create check run: ===\n");
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/check-runs`, {
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
    console.error(`Failed to create check run: ${res.status} ${text}`);
    process.exit(1);
  }

  const data = await res.json();
  console.error(`[check] Created check run ${data.id}: ${params.output.title}`);
}
