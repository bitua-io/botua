import { loadConfig } from "./config";
import { routeEvent } from "./router";
import { JobQueue } from "./queue";
import { startScheduler, schedulerStats } from "./scheduler";

const config = loadConfig();
const queue = new JobQueue(undefined, config.scheduler.max_workers);
const startTime = Date.now();

console.log(`[botua] starting on ${config.server.host}:${config.server.port}`);

Bun.serve({
  port: config.server.port,
  hostname: config.server.host,

  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({
        status: "ok",
        version: "2.0.0",
        uptime: Math.floor((Date.now() - startTime) / 1000),
        jobs: queue.stats(),
        scheduler: schedulerStats(),
      });
    }

    if (req.method === "POST" && url.pathname === "/webhooks/github") {
      return handleGitHubWebhook(req);
    }

    if (req.method === "POST" && url.pathname === "/webhooks/gitea") {
      return handleGiteaWebhook(req);
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`[botua] listening on ${config.server.host}:${config.server.port}`);

// Start the job scheduler
startScheduler(config, queue);

async function handleGitHubWebhook(req: Request): Promise<Response> {
  const signature = req.headers.get("x-hub-signature-256");
  const eventType = req.headers.get("x-github-event");
  const deliveryId = req.headers.get("x-github-delivery");

  if (!eventType) {
    return Response.json({ error: "missing x-github-event header" }, { status: 400 });
  }

  const body = await req.text();

  // Verify signature if webhook secret is configured
  if (config.github.webhook_secret) {
    if (!signature) {
      return Response.json({ error: "missing signature" }, { status: 401 });
    }
    const valid = await verifySignature(body, signature, config.github.webhook_secret);
    if (!valid) {
      return Response.json({ error: "invalid signature" }, { status: 401 });
    }
  }

  let payload: any;
  try {
    payload = JSON.parse(body);
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  // Determine the full event type (e.g., "pull_request.opened")
  const action = payload.action;
  const fullEvent = action ? `${eventType}.${action}` : eventType;

  console.log(`[webhook] github: ${fullEvent} delivery=${deliveryId ?? "?"}`);

  // Log the event
  const eventId = queue.logEvent("github", fullEvent, repoFromPayload(payload), body);

  // Route to handler
  const result = await routeEvent({
    source: "github",
    eventType: fullEvent,
    payload,
    deliveryId: deliveryId ?? undefined,
    config,
    queue,
  });

  if (result?.jobId) {
    queue.linkEventToJob(eventId, result.jobId);
  }

  return Response.json({
    ok: true,
    event: fullEvent,
    ...(result ?? {}),
  });
}

async function handleGiteaWebhook(req: Request): Promise<Response> {
  const eventType = req.headers.get("x-gitea-event");

  if (!eventType) {
    return Response.json({ error: "missing x-gitea-event header" }, { status: 400 });
  }

  const body = await req.text();
  let payload: any;
  try {
    payload = JSON.parse(body);
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const action = payload.action;
  const fullEvent = action ? `${eventType}.${action}` : eventType;

  console.log(`[webhook] gitea: ${fullEvent}`);

  const eventId = queue.logEvent("gitea", fullEvent, repoFromPayload(payload), body);

  const result = await routeEvent({
    source: "gitea",
    eventType: fullEvent,
    payload,
    config,
    queue,
  });

  if (result?.jobId) {
    queue.linkEventToJob(eventId, result.jobId);
  }

  return Response.json({ ok: true, event: fullEvent, ...(result ?? {}) });
}

async function verifySignature(body: string, signature: string, secret: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const expected = "sha256=" + Buffer.from(sig).toString("hex");
  // Constant-time comparison
  if (expected.length !== signature.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}

function repoFromPayload(payload: any): string {
  return payload.repository?.full_name ?? "unknown";
}
