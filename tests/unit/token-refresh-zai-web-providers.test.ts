import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("zai-web-free tokenRefresh provider", () => {
  it("exports refreshZaiWebFreeToken as a function", async () => {
    const mod = await import("../../open-sse/services/tokenRefresh/providers/zaiWebFree.ts");
    assert.equal(typeof mod.refreshZaiWebFreeToken, "function");
  });

  it("returns null when providerSpecificData.token is set (user-supplied JWT)", async () => {
    const { refreshZaiWebFreeToken } =
      await import("../../open-sse/services/tokenRefresh/providers/zaiWebFree.ts");
    const result = await refreshZaiWebFreeToken(
      "ignored",
      { token: "user-supplied-jwt" },
      { warn: () => {}, info: () => {}, error: () => {} },
      null
    );
    assert.equal(result, null);
  });
});

describe("zai-web-token tokenRefresh provider", () => {
  it("exports refreshZaiWebTokenToken as a function", async () => {
    const mod = await import("../../open-sse/services/tokenRefresh/providers/zaiWebToken.ts");
    assert.equal(typeof mod.refreshZaiWebTokenToken, "function");
  });

  it("always returns null (user JWT cannot be refreshed)", async () => {
    const { refreshZaiWebTokenToken } =
      await import("../../open-sse/services/tokenRefresh/providers/zaiWebToken.ts");
    const result = await refreshZaiWebTokenToken(
      "ignored",
      { token: "user-jwt" },
      { warn: () => {}, info: () => {}, error: () => {} },
      null
    );
    assert.equal(result, null);
  });
});

describe("tokenRefresh orchestrator re-exports zai providers", () => {
  it("re-exports refreshZaiWebFreeToken", async () => {
    const mod = await import("../../open-sse/services/tokenRefresh.ts");
    assert.equal(typeof mod.refreshZaiWebFreeToken, "function");
  });

  it("re-exports refreshZaiWebTokenToken", async () => {
    const mod = await import("../../open-sse/services/tokenRefresh.ts");
    assert.equal(typeof mod.refreshZaiWebTokenToken, "function");
  });
});
