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
  const summary = parseSummary(raw);
  const strengths = parseStrengths(raw);
  const issues = parseIssues(raw);

  return { approved, summary, strengths, issues, raw };
}

function parseApproved(text: string): boolean {
  // Explicit APPROVED: true/false
  const explicit = text.match(/APPROVED:\s*(true|false)/i);
  if (explicit) return explicit[1].toLowerCase() === "true";

  // Heuristic: look for approval signals in verdict/status sections
  const lower = text.toLowerCase();

  // Strong rejection signals
  if (/changes\s+requested/i.test(text)) return false;
  if (/\bdo\s+not\s+merge\b/i.test(text)) return false;
  if (/\bmust\s+be\s+fixed\s+before\s+merg/i.test(text)) return false;

  // Look in verdict section specifically
  const verdictSection = extractSection(text, /#{2,4}\s+(?:🏁\s*)?verdict/i);
  if (verdictSection) {
    if (/\bapprove[ds]?\b/i.test(verdictSection) && !/\bnot\s+approve/i.test(verdictSection)) return true;
    if (/\blgtm\b/i.test(verdictSection)) return true;
    if (/changes\s+requested/i.test(verdictSection)) return false;
    if (/\breject/i.test(verdictSection)) return false;
  }

  // Check status line (e.g., "**Status: Approve with nits**")
  const statusMatch = text.match(/\*\*Status:\s*(.+?)\*\*/i);
  if (statusMatch) {
    const status = statusMatch[1].toLowerCase();
    if (status.includes("approve")) return true;
    if (status.includes("reject") || status.includes("request")) return false;
  }

  return false;
}

function parseSummary(text: string): string {
  // Try explicit ### Summary section
  const summarySection = extractSection(text, /#{2,3}\s+summary/i);
  if (summarySection) return summarySection;

  // Try "**Status: ...**" line
  const statusMatch = text.match(/\*\*Status:\s*(.+?)\*\*\s*[—–-]\s*(.+)/);
  if (statusMatch) return statusMatch[2].trim();

  // Try first paragraph after ## Review:
  const reviewMatch = text.match(/##\s+Review:.*?\n\n(.+?)(?:\n\n|---)/s);
  if (reviewMatch) return reviewMatch[1].trim();

  // Fallback: first non-empty paragraph
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim() && !p.startsWith("<!--"));
  return paragraphs[0]?.trim() ?? "";
}

function parseStrengths(text: string): string[] {
  // Try explicit ### Strengths
  const section = extractSection(text, /#{2,3}\s+(?:✅\s*)?(?:strengths?|what'?s?\s+good)/i);
  if (section) return parseBullets(section);
  return [];
}

function parseIssues(text: string): ReviewIssue[] {
  const issues: ReviewIssue[] = [];

  // 1. Try strict format: #### Critical, #### Important, #### Minor
  for (const severity of ["critical", "important", "minor"] as const) {
    const section = extractSection(text, new RegExp(`#{3,4}\\s+${severity}`, "i"));
    if (section && !isEmptySection(section)) {
      for (const issue of extractIssuesFromSection(section, severity)) {
        issues.push(issue);
      }
    }
  }

  if (issues.length > 0) return issues;

  // 2. Try free-form: ⚠️ = important, 📝 = minor, 🚨/❌ = critical
  const importantSection = extractSection(text, /#{2,3}\s+⚠️/);
  const minorSection = extractSection(text, /#{2,3}\s+📝/);
  const criticalSection = extractSection(text, /#{2,3}\s+(?:🚨|❌\s*(?:critical|blocking))/i);

  if (criticalSection) {
    for (const issue of extractIssuesFromSection(criticalSection, "critical")) {
      issues.push(issue);
    }
  }
  if (importantSection) {
    for (const issue of extractIssuesFromSection(importantSection, "important")) {
      issues.push(issue);
    }
  }
  if (minorSection) {
    for (const issue of extractIssuesFromSection(minorSection, "minor")) {
      issues.push(issue);
    }
  }

  return issues;
}

function extractIssuesFromSection(section: string, severity: ReviewIssue["severity"]): ReviewIssue[] {
  const issues: ReviewIssue[] = [];

  // Split by numbered items, bold headers, or #### sub-headers
  const blocks = section.split(/\n(?=\d+\.\s+\*\*|\*\*[^*]+\*\*|#{4}\s+`)/);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed || isEmptySection(trimmed)) continue;

    const fileMatch = trimmed.match(/`([^`]+\.[a-z]{1,5}(?::[0-9]+)?)`/);
    const file = fileMatch ? fileMatch[1] : "";

    // Extract title from first line
    const firstLine = trimmed.split("\n")[0]
      .replace(/^\d+\.\s+/, "")
      .replace(/^\*\*(.+?)\*\*.*/, "$1")
      .replace(/^#{4}\s+/, "")
      .trim();

    if (!firstLine) continue;

    const description = trimmed;
    const sugMatch = trimmed.match(/(?:Fix|Consider|Suggestion|Recommend)(?:ation)?:\s*(.+)/i);

    issues.push({
      severity,
      file,
      description,
      suggestion: sugMatch?.[1]?.trim(),
    });
  }

  return issues;
}

/** Extract text content of a section by its heading pattern, stopping at next heading of same or higher level */
function extractSection(text: string, headingPattern: RegExp): string | null {
  const lines = text.split("\n");
  let capturing = false;
  let headingLevel = 0;
  const captured: string[] = [];

  for (const line of lines) {
    if (!capturing) {
      if (headingPattern.test(line)) {
        capturing = true;
        headingLevel = (line.match(/^(#{2,4})/)?.[1] ?? "##").length;
      }
      continue;
    }

    // Stop at same or higher level heading, or horizontal rule followed by heading
    const nextHeading = line.match(/^(#{2,4})\s/);
    if (nextHeading && nextHeading[1].length <= headingLevel) break;
    if (line.trim() === "---" && captured.length > 0) break;

    captured.push(line);
  }

  const result = captured.join("\n").trim();
  return result || null;
}

function parseBullets(text: string): string[] {
  return text
    .split("\n")
    .filter(line => /^\s*[-*]\s+/.test(line))
    .map(line => line.replace(/^\s*[-*]\s+/, "").replace(/\*\*(.+?)\*\*\s*[—–-]\s*/, "$1: ").trim())
    .filter(Boolean);
}

function isEmptySection(text: string): boolean {
  const cleaned = text.replace(/none\.?/gi, "").replace(/no\s+issues?\.?/gi, "").trim();
  return cleaned.length === 0;
}
