export interface PRInfo {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  labels: string[];
  baseBranch: string;
  headBranch: string;
  headSha: string;
  diff: string;
  changedFiles: string[];
}

export interface ReviewVerdict {
  approved: boolean;
  summary: string;
  strengths: string[];
  issues: ReviewIssue[];
  raw: string;
}

export interface ReviewIssue {
  severity: "critical" | "important" | "minor";
  file: string;
  description: string;
  suggestion?: string;
}

export interface CheckResult {
  conclusion: "success" | "failure" | "action_required";
  title: string;
  summary: string;
}
