/**
 * Pi Extension — Custom tools for the PR reviewer agent.
 *
 * Gives the reviewer access to PR-specific context beyond what
 * pi's built-in read/grep/bash tools provide.
 *
 * Reads PR data from PI_REVIEWER_PR_JSON env var (or /tmp/pr-data.json).
 */

import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function getPRDataPath(): string {
  return process.env.PI_REVIEWER_PR_JSON || "/tmp/pr-data.json";
}

async function loadPRData(): Promise<any> {
  const path = getPRDataPath();
  try {
    return JSON.parse(await Bun.file(path).text());
  } catch {
    throw new Error(`Could not read PR data from ${path}. Set PI_REVIEWER_PR_JSON env var.`);
  }
}

// --- Progress tracking ---
// Reads config from env:
//   BOTUA_PROGRESS_COMMENT_ID — GitHub comment ID to update (CI mode)
//   BOTUA_PROGRESS_REPO       — owner/repo
//   GITHUB_TOKEN              — for API calls
// When no comment ID, falls back to stderr (local/debug mode).

const progressSteps: string[] = [];

async function updateProgress(step: string): Promise<void> {
  const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  progressSteps.push(`\`${timestamp}\` ${step}`);

  const commentId = process.env.BOTUA_PROGRESS_COMMENT_ID;
  const repoSlug = process.env.BOTUA_PROGRESS_REPO;
  const token = process.env.GITHUB_TOKEN;

  // Always print to stderr for debug visibility
  console.error(`[botua:progress] ${step}`);

  if (!commentId || !repoSlug || !token) return;

  const body =
    `<!-- botua-progress -->\n` +
    `## 🔄 Botua — Reviewing...\n\n` +
    progressSteps.map((s) => `- ${s}`).join("\n") +
    `\n\n---\n*Live progress — updates as the review runs*`;

  try {
    await fetch(
      `https://api.github.com/repos/${repoSlug}/issues/comments/${commentId}`,
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
  } catch {
    // Don't fail the review over a progress update
  }
}

export default function (pi: ExtensionAPI) {
  // Tool: report_progress
  pi.registerTool({
    name: "report_progress",
    label: "Progress",
    description:
      "Report what you're doing right now. Call this before each major step so the PR author can see live progress. Examples: 'Reading changed files', 'Running biome check', 'Analyzing blast radius of utils.ts changes', 'Writing final verdict'.",
    parameters: Type.Object({
      status: Type.String({ description: "What you're currently doing (short, human-readable)" }),
    }),
    async execute(_id, params) {
      const { status } = params as { status: string };
      await updateProgress(status);
      return {
        content: [{ type: "text", text: "Progress reported." }],
        details: {},
      };
    },
  });

  // Tool: get_pr_info
  pi.registerTool({
    name: "get_pr_info",
    label: "PR Info",
    description:
      "Get PR metadata: title, description, changed files list, author, labels, branches. Use this first to understand the scope of the PR.",
    parameters: Type.Object({}),
    async execute() {
      const pr = await loadPRData();
      const info = {
        title: pr.title,
        body: pr.body,
        author: pr.author,
        baseBranch: pr.baseBranch,
        headBranch: pr.headBranch,
        changedFiles: pr.changedFiles,
        labels: pr.labels || [],
      };
      return {
        content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
        details: {},
      };
    },
  });

  // Tool: read_file_at_base
  pi.registerTool({
    name: "read_file_at_base",
    label: "Read Base File",
    description:
      "Read a file as it was in the base branch (before PR changes). Useful for understanding what changed compared to the current version.",
    parameters: Type.Object({
      path: Type.String({ description: "File path relative to repo root" }),
    }),
    async execute(_id, params) {
      const pr = await loadPRData();
      const { path } = params as { path: string };
      const proc = Bun.spawnSync(["git", "show", `origin/${pr.baseBranch}:${path}`]);
      if (proc.exitCode !== 0) {
        return {
          content: [
            {
              type: "text",
              text: `File not found in base branch (origin/${pr.baseBranch}): ${path}. It may be a new file in this PR.`,
            },
          ],
          details: {},
        };
      }
      return {
        content: [{ type: "text", text: proc.stdout.toString() }],
        details: {},
      };
    },
  });

  // Tool: get_ci_status
  pi.registerTool({
    name: "get_ci_status",
    label: "CI Status",
    description:
      "Get status of other CI checks on this PR (tests, linting, builds). Helps understand if automated checks already caught issues.",
    parameters: Type.Object({}),
    async execute() {
      const pr = await loadPRData();
      const token = process.env.GITHUB_TOKEN;
      if (!token) {
        return {
          content: [{ type: "text", text: "GITHUB_TOKEN not set, cannot check CI status." }],
          details: {},
        };
      }
      try {
        const res = await fetch(
          `https://api.github.com/repos/${pr.owner}/${pr.repo}/commits/${pr.headSha}/check-runs`,
          {
            headers: {
              Authorization: `token ${token}`,
              Accept: "application/vnd.github+json",
            },
          },
        );
        const data = await res.json();
        const checks = (data.check_runs || [])
          .filter((c: any) => c.name !== "Botua")
          .map((c: any) => ({
            name: c.name,
            status: c.status,
            conclusion: c.conclusion,
          }));
        return {
          content: [{ type: "text", text: JSON.stringify(checks, null, 2) }],
          details: {},
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Failed to fetch CI status: ${e.message}` }],
          details: {},
        };
      }
    },
  });

  // Tool: list_related_files
  pi.registerTool({
    name: "list_related_files",
    label: "Related Files",
    description:
      "Find files that reference or import a given file. Useful for understanding the blast radius of changes — who depends on the modified code.",
    parameters: Type.Object({
      path: Type.String({ description: "File path to find dependents for" }),
    }),
    async execute(_id, params) {
      const { path } = params as { path: string };
      // Extract the module name from the path (without extension)
      const basename = path.replace(/.*\//, "").replace(/\.[^.]+$/, "");
      const proc = Bun.spawnSync([
        "grep",
        "-rl",
        "--include=*.ts",
        "--include=*.tsx",
        "--include=*.js",
        basename,
        ".",
      ]);
      const files = proc.stdout
        .toString()
        .trim()
        .split("\n")
        .filter(Boolean)
        .filter((f) => f !== `./${path}`) // exclude the file itself
        .slice(0, 30);
      return {
        content: [
          {
            type: "text",
            text:
              files.length > 0
                ? `Files referencing "${basename}":\n${files.join("\n")}`
                : `No files found referencing "${basename}".`,
          },
        ],
        details: {},
      };
    },
  });
}
