/** Messages sent from the main process to a worker */
export type InitMessage = {
  type: "init";
  jobId: string;
  repo: string;
  jobType: "pr-review" | "pr-command";
  payload: Record<string, any>;
  workDir: string;
  githubToken: string;
  kimiApiKey: string;
  config: {
    model: string;
    provider: string;
    timeoutMs: number;
  };
  memories: Array<{ category: string; content: string }>;
};

/** Worker reports what it's currently doing */
export type ProgressMessage = {
  type: "progress";
  jobId: string;
  step: string;
};

/** Worker finished successfully */
export type CompleteMessage = {
  type: "complete";
  jobId: string;
  result: Record<string, any>;
};

/** Worker encountered an error */
export type ErrorMessage = {
  type: "error";
  jobId: string;
  error: string;
  stack?: string;
};

/** Worker wants to save a memory for future jobs */
export type MemoryMessage = {
  type: "memory";
  jobId: string;
  repo: string;
  category: string;
  content: string;
};

/** All messages a worker can send back to main */
export type WorkerMessage =
  | ProgressMessage
  | CompleteMessage
  | ErrorMessage
  | MemoryMessage;

// --- Type guards ---

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function isProgressMessage(v: unknown): v is ProgressMessage {
  return isObj(v) && v.type === "progress" && typeof v.jobId === "string" && typeof v.step === "string";
}

export function isCompleteMessage(v: unknown): v is CompleteMessage {
  return isObj(v) && v.type === "complete" && typeof v.jobId === "string" && isObj(v.result);
}

export function isErrorMessage(v: unknown): v is ErrorMessage {
  return isObj(v) && v.type === "error" && typeof v.jobId === "string" && typeof v.error === "string";
}

export function isMemoryMessage(v: unknown): v is MemoryMessage {
  return (
    isObj(v) &&
    v.type === "memory" &&
    typeof v.jobId === "string" &&
    typeof v.repo === "string" &&
    typeof v.category === "string" &&
    typeof v.content === "string"
  );
}
