import { describe, expect, test } from "bun:test";
import { createModelSetup } from "../src/models";

describe("model setup", () => {
  test("creates model registry with kimi provider", () => {
    const setup = createModelSetup({
      provider: "kimi-coding",
      model: "k2p5",
      kimiApiKey: "sk-kimi-test-key",
    });

    expect(setup.modelRegistry).toBeDefined();
    expect(setup.authStorage).toBeDefined();
    expect(setup.model).toBeDefined();
    expect(setup.model.id).toBe("k2p5");
    expect(setup.model.provider).toBe("kimi-coding");
  });

  test("finds the correct model by id", () => {
    const setup = createModelSetup({
      provider: "kimi-coding",
      model: "kimi-k2.6-code-preview",
      kimiApiKey: "sk-kimi-test-key",
    });

    expect(setup.model.id).toBe("kimi-k2.6-code-preview");
  });

  test("throws when model not found", () => {
    expect(() =>
      createModelSetup({
        provider: "kimi-coding",
        model: "nonexistent-model",
        kimiApiKey: "sk-kimi-test-key",
      }),
    ).toThrow();
  });

  test("throws when no API key provided", () => {
    expect(() =>
      createModelSetup({
        provider: "kimi-coding",
        model: "k2p5",
        kimiApiKey: "",
      }),
    ).toThrow();
  });
});
