import { parseArgs } from "util";
import type { ReviewVerdict, ReviewIssue } from "./types";

// CLI mode — only when run directly
if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      file: { type: "string" },
    },
    strict: true,
  });

  let raw: string;
  if (values.file) {
    raw = await Bun.file(values.file).text();
  } else {
    raw = await new Response(Bun.stdin.stream()).text();
  }

  const verdict = parseVerdict(raw);
  console.log(JSON.stringify(verdict, null, 2));
}

// --- parsing logic ---

export function parseVerdict(raw: string): ReviewVerdict {
  const approved = parseApproved(raw);
  const summary = parseSection(raw, "Summary");
  const strengths = parseBullets(parseSection(raw, "Strengths"));
  const issues = parseIssues(raw);

  return { approved, summary, strengths, issues, raw };
}

function parseApproved(text: string): boolean {
  // Look for APPROVED: true/false in a code block or plain text
  const match = text.match(/APPROVED:\s*(true|false)/i);
  if (match) return match[1].toLowerCase() === "true";
  // Fallback: if no explicit verdict, assume not approved
  return false;
}

function parseSection(text: string, heading: string): string {
  // Match ### Heading or ## Heading
  const regex = new RegExp(`#{2,3}\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n#{2,3}\\s|$)`, "i");
  const match = text.match(regex);
  if (!match) return "";
  return match[1].trim();
}

function parseBullets(text: string): string[] {
  if (!text) return [];
  return text
    .split("\n")
    .filter((line) => line.match(/^\s*[-*]\s+/))
    .map((line) => line.replace(/^\s*[-*]\s+/, "").trim())
    .filter(Boolean);
}

function parseIssues(text: string): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  const severities = ["critical", "important", "minor"] as const;

  for (const severity of severities) {
    const section = parseSeveritySection(text, severity);
    if (!section) continue;

    // Split into individual issues by bold headers or numbered items
    const blocks = section.split(/\n(?=\*\*|\d+\.\s)/);
    for (const block of blocks) {
      if (!block.trim()) continue;
      const issue = parseIssueBlock(block, severity);
      if (issue) issues.push(issue);
    }
  }

  return issues;
}

function parseSeveritySection(text: string, severity: string): string | null {
  // Match #### Critical, #### Important, #### Minor
  const regex = new RegExp(
    `#{3,4}\\s+${severity}\\s*\\n([\\s\\S]*?)(?=\\n#{3,4}\\s|\\n#{2,3}\\s+Verdict|$)`,
    "i",
  );
  const match = text.match(regex);
  return match ? match[1].trim() : null;
}

function parseIssueBlock(
  block: string,
  severity: "critical" | "important" | "minor",
): ReviewIssue | null {
  const lines = block.trim().split("\n");
  if (lines.length === 0) return null;

  // Try to extract file reference from the block
  const fileMatch = block.match(/`([^`]+\.[a-z]{1,4}(?::[0-9]+)?)`/);
  const file = fileMatch ? fileMatch[1] : "";

  // First line is typically the title/description
  const title = lines[0].replace(/^\*\*(.+)\*\*.*$/, "$1").replace(/^\d+\.\s+/, "");

  // Rest is the description
  const description = lines
    .slice(0)
    .join("\n")
    .replace(/^(\*\*[^*]+\*\*\s*)/m, "")
    .trim();

  // Look for "Fix:" or "Consider:" suggestions
  const sugMatch = block.match(/\*\*Fix\*\*:\s*(.+)/i) || block.match(/(?:Fix|Consider|Suggestion):\s*(.+)/i);
  const suggestion = sugMatch ? sugMatch[1].trim() : undefined;

  return { severity, file, description: description || title, suggestion };
}
