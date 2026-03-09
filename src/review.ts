import { parseArgs } from "util";
import { resolve, dirname } from "path";
import type { PRInfo } from "./types";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "pr-json": { type: "string" },
    diff: { type: "string" },
    "repo-path": { type: "string" },
    model: { type: "string", default: "k2p5" },
    provider: { type: "string", default: "kimi-coding" },
    verbose: { type: "boolean", default: false },
  },
  strict: true,
});

if (!values["pr-json"] && !values.diff) {
  console.error(
    "Usage: bun run src/review.ts --pr-json <file> [--repo-path <dir>] [--model k2p5] [--provider kimi-coding]",
  );
  console.error("       bun run src/review.ts --diff <file> [--repo-path <dir>]");
  process.exit(1);
}

// Resolve paths relative to the project root
const projectRoot = dirname(dirname(import.meta.path));
const extensionPath = resolve(projectRoot, "extension/reviewer-tools.ts");
const promptPath = resolve(projectRoot, "prompts/review.md");

// Load PR data
let prTitle = "PR Review";
let prBody = "";
let diffContent: string;
let prDataPath: string;

if (values["pr-json"]) {
  const prJsonPath = resolve(values["pr-json"]);
  const prInfo: PRInfo = JSON.parse(await Bun.file(prJsonPath).text());
  prTitle = prInfo.title;
  prBody = prInfo.body;
  diffContent = prInfo.diff;

  // Write PR data to temp file for the extension to read
  prDataPath = "/tmp/botua-pr-data.json";
  await Bun.write(prDataPath, JSON.stringify(prInfo));
} else {
  diffContent = await Bun.file(resolve(values.diff!)).text();
  prDataPath = "/tmp/botua-pr-data.json";
  // Write minimal PR data for extension
  await Bun.write(
    prDataPath,
    JSON.stringify({ title: "Review", body: "", changedFiles: [], baseBranch: "main" }),
  );
}

// Write diff to temp file for @file reference
const diffPath = "/tmp/botua-diff.patch";
await Bun.write(diffPath, diffContent);

// Write system prompt to a temp file — passing it as --system-prompt CLI arg
// works via Bun.spawn (no shell escaping), but using a temp SYSTEM.md in a
// temp .pi dir is cleaner and avoids arg length limits on large prompts.
const tempPiDir = "/tmp/botua-config";
await Bun.write(`${tempPiDir}/SYSTEM.md`, await Bun.file(promptPath).text());

// Copy auth.json if it exists in the user's pi config (local dev).
// In CI, KIMI_API_KEY env var is used instead.
const userAuthPath = `${process.env.HOME}/.pi/agent/auth.json`;
const tempAuthPath = `${tempPiDir}/auth.json`;
if (await Bun.file(userAuthPath).exists() && !(await Bun.file(tempAuthPath).exists())) {
  await Bun.write(tempAuthPath, await Bun.file(userAuthPath).text());
}

// Build pi command
const cwd = values["repo-path"] ? resolve(values["repo-path"]) : process.cwd();

const piArgs = [
  "pi",
  "-p", // print mode
  "--provider", values.provider!,
  "--model", values.model!,
  "--tools", "read,bash,grep,find,ls",
  "--no-skills",
  "--no-session",
  "--no-prompt-templates",
  "-e", extensionPath,
  `@${diffPath}`,
  `Review this pull request.\n\nTitle: ${prTitle}\n\nDescription: ${prBody || "(no description)"}`,
];

if (values.verbose) {
  console.error(`[review] cwd: ${cwd}`);
  console.error(`[review] extension: ${extensionPath}`);
  console.error(`[review] system prompt: ${tempPiDir}/SYSTEM.md`);
  console.error(`[review] pr-data: ${prDataPath}`);
  console.error(`[review] pi command: pi -p --provider ${values.provider} --model ${values.model} --tools read,bash,grep,find,ls -e reviewer-tools.ts @diff.patch "Review this PR..."`)
}

// Run pi
const proc = Bun.spawn(piArgs, {
  cwd,
  stdout: "pipe",
  stderr: values.verbose ? "inherit" : "pipe",
  env: {
    ...process.env,
    PI_REVIEWER_PR_JSON: prDataPath,
    PI_CODING_AGENT_DIR: tempPiDir,
  },
});

const output = await new Response(proc.stdout).text();
const exitCode = await proc.exited;

if (exitCode !== 0) {
  if (!values.verbose) {
    const stderr = await new Response(proc.stderr).text();
    console.error(`[review] pi exited with code ${exitCode}`);
    console.error(stderr);
  }
  process.exit(1);
}

// Output the review to stdout
console.log(output);
