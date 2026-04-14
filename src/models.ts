/**
 * Pi model registry setup — registers kimi-coding provider with API key auth.
 */

import {
  ModelRegistry,
  AuthStorage,
  InMemoryAuthStorageBackend,
} from "@mariozechner/pi-coding-agent";

export interface ModelSetupOptions {
  provider: string;
  model: string;
  kimiApiKey: string;
}

export interface ModelSetup {
  modelRegistry: ModelRegistry;
  authStorage: AuthStorage;
  model: any; // Model type from pi-ai
}

const KIMI_MODELS = [
  {
    id: "k2p5",
    name: "Kimi K2.5",
    reasoning: true,
    input: ["text", "image"] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 32768,
  },
  {
    id: "kimi-k2.6-code-preview",
    name: "Kimi K2.6 Code Preview",
    reasoning: true,
    input: ["text", "image"] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 32768,
  },
  {
    id: "kimi-for-coding",
    name: "Kimi for Coding",
    reasoning: true,
    input: ["text", "image"] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 32768,
  },
  {
    id: "kimi-k2-thinking-turbo",
    name: "Kimi K2 Thinking Turbo",
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 32768,
  },
];

export function createModelSetup(options: ModelSetupOptions): ModelSetup {
  const { provider, model: modelId, kimiApiKey } = options;

  if (!kimiApiKey) {
    throw new Error("KIMI_API_KEY is required");
  }

  const backend = new InMemoryAuthStorageBackend();
  const authStorage = new AuthStorage(backend);
  const modelRegistry = new ModelRegistry(authStorage);

  modelRegistry.registerProvider(provider, {
    baseUrl: "https://api.kimi.com/coding/",
    api: "anthropic-messages",
    apiKey: kimiApiKey,
    models: KIMI_MODELS,
  });

  const model = modelRegistry.find(provider, modelId);
  if (!model) {
    throw new Error(
      `Model "${modelId}" not found in provider "${provider}". ` +
      `Available: ${KIMI_MODELS.map(m => m.id).join(", ")}`,
    );
  }

  return { modelRegistry, authStorage, model };
}
