import { describe, expect, test } from "bun:test";
import { parseVerdict } from "../src/parse-verdict";

describe("parseVerdict", () => {
  test("parses strict format with APPROVED: true", () => {
    const raw = `
### Summary
Good PR, clean code.

### Strengths
- Well tested
- Good naming

#### Critical
None.

#### Important
**Missing error handling** in \`src/api.ts:42\`
The catch block swallows the error.

### Verdict
APPROVED: true
`;
    const v = parseVerdict(raw);
    expect(v.approved).toBe(true);
    expect(v.summary).toContain("Good PR");
    expect(v.strengths).toContain("Well tested");
  });

  test("parses strict format with APPROVED: false", () => {
    const raw = `
### Summary
Needs work.

#### Critical
**SQL injection** in \`db.ts:10\`
User input is concatenated into query.

#### Important
**No tests** for the new endpoint.

### Verdict
APPROVED: false
`;
    const v = parseVerdict(raw);
    expect(v.approved).toBe(false);
    expect(v.issues.length).toBeGreaterThanOrEqual(2);
    expect(v.issues.filter(i => i.severity === "critical")).toHaveLength(1);
    expect(v.issues.filter(i => i.severity === "important")).toHaveLength(1);
  });

  test("parses kimi free-form format with emoji headers", () => {
    const raw = `
## Review: feat(orchestrator): add multi-reader RFID adapter layer

**Status: Approve with nits** — the architecture is clean.

---

### ✅ What's good

* **Backward-compatible defaults** — good stuff.
* **Clean encapsulation** — nice refactor.

---

### ⚠️ Missing tests (strongly recommended)

1. **Keonn health check (\`createKeonnRfidCheckService\`)**
   No tests for MQTT ping/pong logic.

2. **\`reader-adapter.ts\` (\`parseReaderPayload\`)**
   No unit tests for the Zebra parser.

3. **MQTT-only ingress in \`rfid.service.ts\`**
   Add tests when readerUrl is omitted.

---

### 📝 Code-level notes

#### \`src/rfid/reader-adapter.ts\` — type naming
Consider renaming ParseWebhookResult.

#### \`src/rfid/rfid-check.service.ts\` — Zebra subscription lifecycle
No matching unsubscribe on teardown.

---

### 🏁 Verdict

The code is correct. Please add the missing unit tests before merging.
`;
    const v = parseVerdict(raw);
    // "Approve with nits" = approved (minor issues only)
    expect(v.approved).toBe(true);
    expect(v.summary).toContain("architecture is clean");
    expect(v.strengths.length).toBeGreaterThanOrEqual(1);
    // Should find issues from both ⚠️ and 📝 sections
    expect(v.issues.length).toBeGreaterThanOrEqual(3);
    // ⚠️ section should be important
    expect(v.issues.some(i => i.severity === "important")).toBe(true);
    // 📝 section should be minor
    expect(v.issues.some(i => i.severity === "minor")).toBe(true);
  });

  test("detects approval from 'approve' in verdict/status text", () => {
    const raw = `
### Summary
Looks great.

### 🏁 Verdict
LGTM, approve. No issues found.
`;
    const v = parseVerdict(raw);
    expect(v.approved).toBe(true);
  });

  test("detects rejection from 'changes requested' text", () => {
    const raw = `
**Verdict:** Changes requested. Fix the SQL injection.
`;
    const v = parseVerdict(raw);
    expect(v.approved).toBe(false);
  });

  test("handles empty input", () => {
    const v = parseVerdict("");
    expect(v.approved).toBe(false);
    expect(v.summary).toBe("");
    expect(v.issues).toEqual([]);
  });
});
