import { updateCheckRun } from "./github";
import type { JobQueue } from "./queue";
import type { BotuaConfig } from "./config";
import type { ActiveWorker } from "./scheduler";

export function setupGracefulShutdown(
  config: BotuaConfig,
  queue: JobQueue,
  server: { stop: () => void },
  scheduler: { stop: () => void; activeWorkers: Map<string, ActiveWorker> },
  timeoutMs = 10000,
): void {
  let shuttingDown = false;

  async function doShutdown(signal: string): Promise<boolean> {
    console.log(`[shutdown] graceful shutdown initiated (signal=${signal})`);
    server.stop();
    scheduler.stop();

    const errors: any[] = [];

    for (const [jobId, active] of scheduler.activeWorkers) {
      console.log(`[shutdown] cancelling job ${jobId}`);

      try {
        if (active.payload.check_run_id) {
          const [owner, repoName] = active.repo.split("/");
          await updateCheckRun(active.token, owner, repoName, active.payload.check_run_id, {
            status: "completed",
            conclusion: "cancelled",
            output: {
              title: "Botua — Review cancelled",
              summary: "Review was cancelled by service shutdown. Push a new commit or comment `@botua review` to retry.",
            },
          });
        }
      } catch (err: any) {
        console.error(`[shutdown] failed to update check run for job ${jobId}:`, err.message);
        errors.push(err);
      }

      try {
        queue.failJob(jobId, "Cancelled by shutdown");
      } catch (err: any) {
        console.error(`[shutdown] failed to fail job ${jobId}:`, err.message);
        errors.push(err);
      }

      try {
        active.worker.terminate();
      } catch (err: any) {
        console.error(`[shutdown] failed to terminate worker for job ${jobId}:`, err.message);
        errors.push(err);
      }
    }

    try {
      queue.close();
    } catch (err: any) {
      console.error(`[shutdown] failed to close queue:`, err.message);
      errors.push(err);
    }

    if (errors.length > 0) {
      console.error(`[shutdown] completed with ${errors.length} error(s)`);
    } else {
      console.log("[shutdown] graceful shutdown complete");
    }

    return errors.length > 0;
  }

  function onSignal(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;

    const timeout = setTimeout(() => {
      console.error("[shutdown] timeout reached, forcing exit");
      process.exit(1);
    }, timeoutMs);

    doShutdown(signal)
      .then((hasErrors) => {
        clearTimeout(timeout);
        process.exit(hasErrors ? 1 : 0);
      })
      .catch((err) => {
        console.error("[shutdown] unexpected error:", err);
        clearTimeout(timeout);
        process.exit(1);
      });
  }

  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));
}
