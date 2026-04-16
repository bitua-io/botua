import { describe, expect, test } from "bun:test";
import { parseClassifierOutput, type ClassifyResponse } from "../src/classifier";

describe("classifier output parsing", () => {
  test("parses valid JSON response", () => {
    const output = '{"relevant": true, "intent": "acknowledge", "confidence": 0.9, "reason": "User acknowledges review finding"}';
    const result = parseClassifierOutput("req-1", output);

    expect(result.relevant).toBe(true);
    expect(result.intent).toBe("acknowledge");
    expect(result.confidence).toBe(0.9);
    expect(result.reason).toBe("User acknowledges review finding");
  });

  test("parses JSON wrapped in markdown code block", () => {
    const output = '```json\n{"relevant": true, "intent": "request_action", "confidence": 0.85, "reason": "Asks to create issue"}\n```';
    const result = parseClassifierOutput("req-2", output);

    expect(result.relevant).toBe(true);
    expect(result.intent).toBe("request_action");
    expect(result.confidence).toBe(0.85);
  });

  test("parses JSON with surrounding text", () => {
    const output = 'Here is my classification:\n{"relevant": false, "intent": "unrelated", "confidence": 0.95, "reason": "Discussing CI"}\nThat is my answer.';
    const result = parseClassifierOutput("req-3", output);

    expect(result.relevant).toBe(false);
    expect(result.intent).toBe("unrelated");
  });

  test("handles missing fields with defaults", () => {
    const output = '{"relevant": true}';
    const result = parseClassifierOutput("req-4", output);

    expect(result.relevant).toBe(true);
    expect(result.intent).toBe("unrelated");
    expect(result.confidence).toBe(0);
  });

  test("returns unrelated for invalid JSON", () => {
    const result = parseClassifierOutput("req-5", "I cannot classify this comment");

    expect(result.relevant).toBe(false);
    expect(result.intent).toBe("unrelated");
    expect(result.confidence).toBe(0);
    expect(result.reason).toBe("Failed to parse classifier output");
  });

  test("returns unrelated for empty output", () => {
    const result = parseClassifierOutput("req-6", "");

    expect(result.relevant).toBe(false);
    expect(result.intent).toBe("unrelated");
    expect(result.confidence).toBe(0);
  });

  test("parses each intent type", () => {
    const intents = ["acknowledge", "question", "request_action", "disagree", "unrelated"] as const;
    for (const intent of intents) {
      const output = JSON.stringify({ relevant: intent !== "unrelated", intent, confidence: 0.8, reason: "test" });
      const result = parseClassifierOutput(`req-${intent}`, output);
      expect(result.intent).toBe(intent);
    }
  });

  test("clamps confidence to 0-1 range", () => {
    const output = '{"relevant": true, "intent": "acknowledge", "confidence": 1.5, "reason": "test"}';
    const result = parseClassifierOutput("req-7", output);
    expect(result.confidence).toBe(1);

    const output2 = '{"relevant": true, "intent": "acknowledge", "confidence": -0.5, "reason": "test"}';
    const result2 = parseClassifierOutput("req-8", output2);
    expect(result2.confidence).toBe(0);
  });
});
