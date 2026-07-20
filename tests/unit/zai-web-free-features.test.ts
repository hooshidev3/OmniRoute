import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("zai-web-free features + reasoning", () => {
  it("resolveFeatures: enable_thinking defaults to true", async () => {
    // Read the source and verify the default
    const fs = await import("node:fs");
    const content = fs.readFileSync("open-sse/executors/zai-web-free.ts", "utf-8");
    // Check enable_thinking: true is the default
    assert.ok(
      content.includes("enable_thinking: true, // default: true"),
      "enable_thinking should default to true"
    );
  });

  it("resolveFeatures: 'think' is never in features", async () => {
    const fs = await import("node:fs");
    const content = fs.readFileSync("open-sse/executors/zai-web-free.ts", "utf-8");
    // Check that 'think' is deleted
    assert.ok(content.includes("delete features.think"), "'think' should be deleted from features");
    // Check that think: false is NOT in the initial features object
    assert.ok(
      !content.includes("think: false,"),
      "'think: false' should not be in initial features"
    );
  });

  it("resolveFeatures: supports reasoning (bool)", async () => {
    const fs = await import("node:fs");
    const content = fs.readFileSync("open-sse/executors/zai-web-free.ts", "utf-8");
    assert.ok(
      content.includes('typeof bodyObj.reasoning === "boolean"'),
      "Should support reasoning (bool)"
    );
  });

  it("resolveFeatures: supports thinking (object with type)", async () => {
    const fs = await import("node:fs");
    const content = fs.readFileSync("open-sse/executors/zai-web-free.ts", "utf-8");
    assert.ok(
      content.includes('thinkCfg.type === "enabled"'),
      "Should support thinking: {type: 'enabled'}"
    );
  });

  it("resolveFeatures: webSearch false removes features entirely", async () => {
    const fs = await import("node:fs");
    const content = fs.readFileSync("open-sse/executors/zai-web-free.ts", "utf-8");
    assert.ok(
      content.includes("delete features.auto_web_search"),
      "webSearch=false should delete auto_web_search"
    );
    assert.ok(
      content.includes("delete features.web_search"),
      "webSearch=false should delete web_search"
    );
  });

  it("<details> parsing uses stateful parser (streaming)", async () => {
    const fs = await import("node:fs");
    const content = fs.readFileSync("open-sse/executors/zai-web-free.ts", "utf-8");
    // The streaming path should use the stateful parser (not inline regex)
    assert.ok(
      content.includes("createDetailsParser"),
      "Should use createDetailsParser for streaming <details> parsing"
    );
    assert.ok(
      content.includes("detailsParser.push"),
      "Should call detailsParser.push() for each chunk"
    );
  });

  it("<details> parsing uses stateful parser (non-streaming)", async () => {
    const fs = await import("node:fs");
    const content = fs.readFileSync("open-sse/executors/zai-web-free.ts", "utf-8");
    // Check that the non-streaming path uses createDetailsParser too
    const catchIdx = content.indexOf("best-effort");
    assert.ok(catchIdx > 0, "Should have best-effort catch block");
    const afterCatch = content.slice(catchIdx);
    assert.ok(
      afterCatch.includes("createDetailsParser"),
      "Should use createDetailsParser in non-streaming path"
    );
  });
});

describe("zai-web-free captcha tuning", () => {
  it("token-collector has updated values", async () => {
    const fs = await import("node:fs");
    const content = fs.readFileSync("open-sse/executors/zai-web-free/token-collector.ts", "utf-8");
    assert.ok(content.includes("const MAX_TOKENS = 1500"), "MAX_TOKENS should be 1500");
    assert.ok(content.includes("const DEFAULT_TOKENS = 850"), "DEFAULT_TOKENS should be 850");
    assert.ok(content.includes("const DEFAULT_BATCH = 5"), "DEFAULT_BATCH should be 5");
    assert.ok(content.includes("const SEND_WAIT_MS = 15000"), "SEND_WAIT_MS should be 15000");
  });

  it("auto-refresh-daemon uses 850 tokens", async () => {
    const fs = await import("node:fs");
    const content = fs.readFileSync(
      "open-sse/executors/zai-web-free/auto-refresh-daemon.ts",
      "utf-8"
    );
    assert.ok(content.includes("tokens: 850"), "auto-refresh should use 850 tokens");
  });
});

describe("zai-web-free peak hour retry", () => {
  it("peak hour errors return 503 (retryable)", async () => {
    const fs = await import("node:fs");
    const content = fs.readFileSync("open-sse/executors/zai-web-free.ts", "utf-8");
    assert.ok(
      content.includes('lower.includes("peak hours")'),
      "Should detect 'peak hours' in error"
    );
    assert.ok(content.includes("return 503"), "Peak hour errors should return 503");
  });

  it("cooldown-aware retry maxRetries default is 10", async () => {
    const fs = await import("node:fs");
    const content = fs.readFileSync("src/lib/resilience/settings.ts", "utf-8");
    assert.ok(
      content.includes("maxRetries: 10"),
      "Default maxRetries should be 10 (increased from 3 for peak-hour resilience)"
    );
  });

  it("MAX_REQUEST_RETRY is 10 (hard cap)", async () => {
    const fs = await import("node:fs");
    const content = fs.readFileSync("src/sse/services/cooldownAwareRetry.ts", "utf-8");
    assert.ok(content.includes("const MAX_REQUEST_RETRY = 10"), "MAX_REQUEST_RETRY should be 10");
  });
});
