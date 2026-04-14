/**
 * Tiny test worker that echoes back a complete message.
 * Used by scheduler tests to verify worker lifecycle without pi.
 */

declare var self: Worker;

self.onmessage = (event: MessageEvent) => {
  const msg = event.data;
  if (msg.type !== "init") return;

  // Simulate progress
  self.postMessage({ type: "progress", jobId: msg.jobId, step: "echo-worker started" });

  // Simulate a short delay then complete
  setTimeout(() => {
    self.postMessage({
      type: "complete",
      jobId: msg.jobId,
      result: {
        echo: true,
        approved: true,
        verdict: {
          approved: true,
          summary: "Test review",
          strengths: [],
          issues: [],
          raw: "APPROVED: true\n\n### Summary\nTest review\n\n### Verdict\nAPPROVED: true",
        },
      },
    });
  }, 100);
};
