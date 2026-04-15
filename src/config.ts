import { readFileSync } from "fs";
import { resolve } from "path";

export interface BotuaConfig {
  server: {
    port: number;
    host: string;
  };
  github: {
    app_id: number;
    private_key_path: string;
    webhook_secret: string;
  };
  sandbox: {
    runtime: "podman" | "docker";
    image: string;
    max_concurrent_jobs: number;
    job_timeout_minutes: number;
  };
  ai: {
    model: string;
    provider: string;
  };
  repos: {
    data_dir: string;
  };
  scheduler: {
    poll_interval_ms: number;
    max_workers: number;
  };
  workers: {
    review_timeout_ms: number;
    command_timeout_ms: number;
  };
}

const defaults: BotuaConfig = {
  server: {
    port: 7800,
    host: "0.0.0.0",
  },
  github: {
    app_id: 0,
    private_key_path: "",
    webhook_secret: "",
  },
  sandbox: {
    runtime: "podman",
    image: "botua-base:latest",
    max_concurrent_jobs: 2,
    job_timeout_minutes: 25,
  },
  ai: {
    model: "k2p5",
    provider: "kimi-coding",
  },
  repos: {
    data_dir: "/home/botua/repos",
  },
  scheduler: {
    poll_interval_ms: 2000,
    max_workers: 3,
  },
  workers: {
    review_timeout_ms: 20 * 60 * 1000,
    command_timeout_ms: 25 * 60 * 1000,
  },
};

export function loadConfig(path?: string): BotuaConfig {
  const configPath = path ?? resolve(process.cwd(), "botua.config.json");

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    return deepMerge(defaults, parsed);
  } catch {
    // No config file — use defaults + env overrides
    return applyEnvOverrides(defaults);
  }
}

function applyEnvOverrides(config: BotuaConfig): BotuaConfig {
  const env = process.env;
  if (env.PORT) config.server.port = parseInt(env.PORT);
  if (env.HOST) config.server.host = env.HOST;
  if (env.GITHUB_APP_ID) config.github.app_id = parseInt(env.GITHUB_APP_ID);
  if (env.GITHUB_PRIVATE_KEY_PATH) config.github.private_key_path = env.GITHUB_PRIVATE_KEY_PATH;
  if (env.GITHUB_WEBHOOK_SECRET) config.github.webhook_secret = env.GITHUB_WEBHOOK_SECRET;
  if (env.SANDBOX_IMAGE) config.sandbox.image = env.SANDBOX_IMAGE;
  if (env.MAX_CONCURRENT_JOBS) config.sandbox.max_concurrent_jobs = parseInt(env.MAX_CONCURRENT_JOBS);
  if (env.AI_MODEL) config.ai.model = env.AI_MODEL;
  if (env.AI_PROVIDER) config.ai.provider = env.AI_PROVIDER;
  if (env.REPOS_DIR) config.repos.data_dir = env.REPOS_DIR;
  return config;
}

function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
  const result = { ...target };
  for (const key in source) {
    const val = source[key];
    if (val && typeof val === "object" && !Array.isArray(val) && typeof result[key] === "object") {
      result[key] = deepMerge(result[key], val);
    } else if (val !== undefined) {
      (result as any)[key] = val;
    }
  }
  return result;
}
