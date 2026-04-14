/**
 * GitHub App creation via manifest flow.
 *
 * 1. Starts a local server with the manifest form
 * 2. You open the URL in your browser and click "Create GitHub App"
 * 3. GitHub redirects back with a code
 * 4. We exchange the code for the app credentials (id, private key, webhook secret)
 * 5. Saves everything to .env and the private key to a file
 */

const ORG = "bitua-io";
const PORT = 3456;
const REDIRECT_URL = `http://localhost:${PORT}/callback`;

const manifest = {
  name: "Botua",
  description: "Bitua dev automation bot — automated PR reviews, interactive commands.",
  url: "https://botua.bitua.dev",
  hook_attributes: {
    url: "https://botua.bitua.dev/webhooks/github",
    active: true,
  },
  redirect_url: REDIRECT_URL,
  public: false,
  default_events: [
    "pull_request",
    "issue_comment",
    "pull_request_review_comment",
  ],
  default_permissions: {
    contents: "write",
    pull_requests: "write",
    checks: "write",
    issues: "write",
    metadata: "read",
  },
};

console.log(`\nStarting GitHub App manifest flow for org: ${ORG}`);
console.log(`\nOpen this URL in your browser:\n`);
console.log(`  http://localhost:${PORT}\n`);

let resolve: (value: void) => void;
const done = new Promise<void>((r) => { resolve = r; });

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/" && req.method === "GET") {
      // Serve the form that POSTs to GitHub
      const html = `<!DOCTYPE html>
<html>
<body>
  <h2>Create Botua GitHub App</h2>
  <p>Click the button below to create the app on the <strong>${ORG}</strong> org.</p>
  <form action="https://github.com/organizations/${ORG}/settings/apps/new" method="post">
    <input type="hidden" name="manifest" value='${JSON.stringify(manifest)}'>
    <button type="submit" style="font-size:1.5em;padding:10px 30px;cursor:pointer">
      Create GitHub App
    </button>
  </form>
</body>
</html>`;
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    }

    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      if (!code) {
        return new Response("Missing code parameter", { status: 400 });
      }

      console.log(`\nReceived code: ${code}`);
      console.log("Exchanging for credentials...\n");

      // Exchange the code for the app credentials
      const res = await fetch(
        `https://api.github.com/app-manifests/${code}/conversions`,
        { method: "POST", headers: { Accept: "application/vnd.github+json" } },
      );

      if (!res.ok) {
        const text = await res.text();
        console.error(`Failed: ${res.status} ${text}`);
        return new Response(`Failed to exchange code: ${res.status}`, { status: 500 });
      }

      const data = await res.json();

      const appId = data.id;
      const appName = data.name;
      const clientId = data.client_id;
      const clientSecret = data.client_secret;
      const webhookSecret = data.webhook_secret;
      const pem = data.pem;
      const slug = data.slug;
      const htmlUrl = data.html_url;

      console.log("=== GitHub App Created! ===");
      console.log(`Name:           ${appName}`);
      console.log(`App ID:         ${appId}`);
      console.log(`Slug:           ${slug}`);
      console.log(`Client ID:      ${clientId}`);
      console.log(`URL:            ${htmlUrl}`);
      console.log(`Webhook Secret: ${webhookSecret}`);
      console.log(`Private Key:    saved to github-app.pem`);

      // Save private key
      await Bun.write("github-app.pem", pem);
      console.log(`\nWrote github-app.pem`);

      // Append to .env
      const envLines = [
        `\n# GitHub App (created ${new Date().toISOString().split("T")[0]})`,
        `GITHUB_APP_ID=${appId}`,
        `GITHUB_APP_SLUG=${slug}`,
        `GITHUB_CLIENT_ID=${clientId}`,
        `GITHUB_CLIENT_SECRET=${clientSecret}`,
        `GITHUB_WEBHOOK_SECRET=${webhookSecret}`,
        `GITHUB_PRIVATE_KEY_PATH=./github-app.pem`,
      ];

      const existing = await Bun.file(".env").text().catch(() => "");
      await Bun.write(".env", existing + envLines.join("\n") + "\n");
      console.log("Updated .env with app credentials\n");

      // Update botua.config.json
      const config = JSON.parse(await Bun.file("botua.config.json").text());
      config.github.app_id = appId;
      config.github.private_key_path = "./github-app.pem";
      config.github.webhook_secret = webhookSecret;
      await Bun.write("botua.config.json", JSON.stringify(config, null, 2) + "\n");
      console.log("Updated botua.config.json\n");

      console.log("=== Next: install the app on the org ===");
      console.log(`  ${htmlUrl}/installations/new\n`);

      setTimeout(() => { server.stop(); resolve(); }, 500);

      return new Response(
        `<html><body>
          <h2>Botua GitHub App created!</h2>
          <p>App ID: <strong>${appId}</strong></p>
          <p>Now <a href="${htmlUrl}/installations/new">install it on the ${ORG} org</a>.</p>
          <p>You can close this tab.</p>
        </body></html>`,
        { headers: { "Content-Type": "text/html" } },
      );
    }

    return new Response("Not found", { status: 404 });
  },
});

await done;
console.log("Done! Server stopped.");
