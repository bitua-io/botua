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

export default function (pi: ExtensionAPI) {
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
          .filter((c: any) => c.name !== "Pi Review")
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
