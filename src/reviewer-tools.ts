/**
 * Custom review tools for the PR reviewer agent — library mode.
 *
 * Adapted from extension/reviewer-tools.ts to work as standalone
 * ToolDefinition objects for createAgentSession({ customTools }).
 */

import { Type } from "@mariozechner/pi-ai";

export interface PRData {
  title: string;
  body: string;
  author: string;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  changedFiles: string[];
  labels: string[];
  owner: string;
  repo: string;
}

type ToolDef = {
  name: string;
  label: string;
  description: string;
  parameters: any;
  execute: (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => Promise<any>;
};

/**
 * Create reviewer tools for a specific PR and workspace.
 *
 * @param prData — PR metadata (injected, not read from file)
 * @param cwd — worktree directory
 * @param onProgress — callback when agent reports progress
 * @param githubToken — optional, for CI status checks
 */
export function createReviewerTools(
  prData: PRData,
  cwd: string,
  onProgress: (step: string) => void,
  githubToken?: string,
): ToolDef[] {
  return [
    {
      name: "report_progress",
      label: "Progress",
      description:
        "Report what you're doing right now. Call this before each major step so the PR author can see live progress.",
      parameters: Type.Object({
        status: Type.String({ description: "What you're currently doing (short, human-readable)" }),
      }),
      async execute(_id, params) {
        onProgress(params.status);
        return { content: [{ type: "text", text: "Progress reported." }], details: {} };
      },
    },

    {
      name: "get_pr_info",
      label: "PR Info",
      description:
        "Get PR metadata: title, description, changed files list, author, labels, branches.",
      parameters: Type.Object({}),
      async execute() {
        const info = {
          title: prData.title,
          body: prData.body,
          author: prData.author,
          baseBranch: prData.baseBranch,
          headBranch: prData.headBranch,
          changedFiles: prData.changedFiles,
          labels: prData.labels,
        };
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }], details: {} };
      },
    },

    {
      name: "read_file_at_base",
      label: "Read Base File",
      description:
        "Read a file as it was in the base branch (before PR changes). Useful for understanding what changed.",
      parameters: Type.Object({
        path: Type.String({ description: "File path relative to repo root" }),
      }),
      async execute(_id, params) {
        const proc = Bun.spawnSync(["git", "show", `${prData.baseBranch}:${params.path}`], {
          cwd,
          stdout: "pipe",
          stderr: "pipe",
        });
        if (proc.exitCode !== 0) {
          return {
            content: [{
              type: "text",
              text: `File not found in base branch (${prData.baseBranch}): ${params.path}. It may be a new file.`,
            }],
            details: {},
          };
        }
        return { content: [{ type: "text", text: proc.stdout.toString() }], details: {} };
      },
    },

    {
      name: "get_ci_status",
      label: "CI Status",
      description:
        "Get status of other CI checks on this PR (tests, linting, builds).",
      parameters: Type.Object({}),
      async execute() {
        if (!githubToken) {
          return { content: [{ type: "text", text: "No GitHub token — cannot check CI status." }], details: {} };
        }
        try {
          const res = await fetch(
            `https://api.github.com/repos/${prData.owner}/${prData.repo}/commits/${prData.headSha}/check-runs`,
            { headers: { Authorization: `token ${githubToken}`, Accept: "application/vnd.github+json" } },
          );
          const data = await res.json();
          const checks = (data.check_runs || [])
            .filter((c: any) => c.name !== "Botua")
            .map((c: any) => ({ name: c.name, status: c.status, conclusion: c.conclusion }));
          return { content: [{ type: "text", text: JSON.stringify(checks, null, 2) }], details: {} };
        } catch (e: any) {
          return { content: [{ type: "text", text: `Failed to fetch CI status: ${e.message}` }], details: {} };
        }
      },
    },

    {
      name: "list_related_files",
      label: "Related Files",
      description:
        "Find files that reference or import a given file. Useful for understanding the blast radius of changes.",
      parameters: Type.Object({
        path: Type.String({ description: "File path to find dependents for" }),
      }),
      async execute(_id, params) {
        const basename = params.path.replace(/.*\//, "").replace(/\.[^.]+$/, "");
        const proc = Bun.spawnSync(
          ["grep", "-rl", "--include=*.ts", "--include=*.tsx", "--include=*.js", basename, "."],
          { cwd, stdout: "pipe", stderr: "pipe" },
        );
        const files = proc.stdout.toString().trim().split("\n")
          .filter(Boolean)
          .filter(f => f !== `./${params.path}`)
          .slice(0, 30);

        const text = files.length > 0
          ? `Files referencing "${basename}":\n${files.join("\n")}`
          : `No files found referencing "${basename}".`;
        return { content: [{ type: "text", text }], details: {} };
      },
    },
  ];
}
