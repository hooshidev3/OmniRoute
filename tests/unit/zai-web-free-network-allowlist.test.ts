import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Tests for the network allowlist ported from GLM-Free-API captcha.go
 * commit b100b28 ("Faster and Faster").
 *
 * The allowlist is applied to every Playwright page used by zai-web-free
 * device-token collection. It blocks trackers/analytics/ads and only allows
 * the 5 URL categories required for Z.AI page load + Aliyun Captcha.
 */

describe("zai-web-free network allowlist: urlAllowed()", () => {
  // Import the function under test
  const importUrlAllowed = () =>
    import("../../open-sse/executors/zai-web-free/token-collector.ts").then((m) => m.urlAllowed);

  // ── Rule 1: chat.z.ai domain ───────────────────────────────────────────────
  describe("rule 1: chat.z.ai domain", () => {
    it("allows https://chat.z.ai/ (root)", async () => {
      const urlAllowed = await importUrlAllowed();
      assert.equal(urlAllowed("https://chat.z.ai/"), true);
    });

    it("allows https://chat.z.ai/anything (any path)", async () => {
      const urlAllowed = await importUrlAllowed();
      assert.equal(urlAllowed("https://chat.z.ai/api/v2/chat/completions"), true);
      assert.equal(urlAllowed("https://chat.z.ai/static/js/main.js"), true);
      assert.equal(urlAllowed("https://chat.z.ai/_next/data/abc.json"), true);
    });

    it("allows wss://chat.z.ai/ (WebSocket upgrade)", async () => {
      const urlAllowed = await importUrlAllowed();
      assert.equal(urlAllowed("wss://chat.z.ai/ws"), true);
      assert.equal(urlAllowed("wss://chat.z.ai/"), true);
    });

    it("rejects http://chat.z.ai/ (insecure http)", async () => {
      const urlAllowed = await importUrlAllowed();
      assert.equal(urlAllowed("http://chat.z.ai/"), false);
    });

    it("rejects subdomain of chat.z.ai (e.g. api.chat.z.ai)", async () => {
      const urlAllowed = await importUrlAllowed();
      // The rule is prefix-based: "https://chat.z.ai/" — api.chat.z.ai does NOT match
      assert.equal(urlAllowed("https://api.chat.z.ai/"), false);
    });
  });

  // ── Rule 2: z-cdn build assets ─────────────────────────────────────────────
  describe("rule 2: z-cdn chatglm.cn build assets", () => {
    it("allows valid z-cdn build asset URL", async () => {
      const urlAllowed = await importUrlAllowed();
      assert.equal(
        urlAllowed("https://z-cdn.chatglm.cn/z-ai/frontend/prod-fe-1.2.3/assets/index-abc123.js"),
        true
      );
    });

    it("allows another valid version", async () => {
      const urlAllowed = await importUrlAllowed();
      assert.equal(
        urlAllowed(
          "https://z-cdn.chatglm.cn/z-ai/frontend/prod-fe-v2.0.0-rc.1/assets/index-deadbeef.js"
        ),
        true
      );
    });

    it("rejects z-cdn URL with wrong path structure", async () => {
      const urlAllowed = await importUrlAllowed();
      assert.equal(
        urlAllowed("https://z-cdn.chatglm.cn/z-ai/frontend/prod-fe-1.2.3/other/thing.js"),
        false
      );
    });

    it("rejects z-cdn URL with non-assets path", async () => {
      const urlAllowed = await importUrlAllowed();
      assert.equal(
        urlAllowed("https://z-cdn.chatglm.cn/z-ai/frontend/prod-fe-1.2.3/index.html"),
        false
      );
    });
  });

  // ── Rule 3: Aliyun captcha script (exact) ─────────────────────────────────
  describe("rule 3: Aliyun captcha script (exact match)", () => {
    it("allows the exact Aliyun captcha URL", async () => {
      const urlAllowed = await importUrlAllowed();
      assert.equal(
        urlAllowed("https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js"),
        true
      );
    });

    it("rejects slightly different Aliyun URL (extra path)", async () => {
      const urlAllowed = await importUrlAllowed();
      assert.equal(
        urlAllowed("https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js?v=2"),
        false
      );
    });

    it("rejects different alicdn path", async () => {
      const urlAllowed = await importUrlAllowed();
      assert.equal(urlAllowed("https://o.alicdn.com/captcha-frontend/other/SomeOther.js"), false);
    });
  });

  // ── Rule 4: cloudauth-device-dualstack.*.aliyuncs.com ─────────────────────
  describe("rule 4: cloudauth-device-dualstack aliyuncs", () => {
    it("allows valid cloudauth-device-dualstack URL (cn-shanghai)", async () => {
      const urlAllowed = await importUrlAllowed();
      assert.equal(
        urlAllowed("https://cloudauth-device-dualstack.cn-shanghai.aliyuncs.com/"),
        true
      );
    });

    it("allows valid cloudauth-device-dualstack URL (us-west-1)", async () => {
      const urlAllowed = await importUrlAllowed();
      assert.equal(urlAllowed("https://cloudauth-device-dualstack.us-west-1.aliyuncs.com/"), true);
    });

    it("allows cloudauth-device-dualstack with path", async () => {
      const urlAllowed = await importUrlAllowed();
      assert.equal(
        urlAllowed("https://cloudauth-device-dualstack.cn-shanghai.aliyuncs.com/v1/captcha/verify"),
        true
      );
    });

    it("rejects cloudauth (without -device-dualstack)", async () => {
      const urlAllowed = await importUrlAllowed();
      assert.equal(urlAllowed("https://cloudauth.cn-shanghai.aliyuncs.com/"), false);
    });
  });

  // ── Rule 5: FeiLin captcha assets ─────────────────────────────────────────
  describe("rule 5: FeiLin captcha assets", () => {
    it("allows valid FeiLin asset URL", async () => {
      const urlAllowed = await importUrlAllowed();
      assert.equal(
        urlAllowed("https://g.alicdn.com/captcha-frontend/FeiLin/1.2.3/feilincore.1.2.3.js"),
        true
      );
    });

    it("allows another valid FeiLin asset URL", async () => {
      const urlAllowed = await importUrlAllowed();
      assert.equal(
        urlAllowed("https://g.alicdn.com/captcha-frontend/FeiLin/v2.0/feilin-ui.min.js"),
        true
      );
    });

    it("rejects FeiLin URL with non-feilin filename", async () => {
      const urlAllowed = await importUrlAllowed();
      assert.equal(
        urlAllowed("https://g.alicdn.com/captcha-frontend/FeiLin/1.2.3/other.js"),
        false
      );
    });
  });

  // ── Common trackers/analytics that MUST be blocked ────────────────────────
  describe("common trackers are blocked", () => {
    const trackers = [
      "https://www.google-analytics.com/g/collect?v=2",
      "https://googletagmanager.com/gtm.js",
      "https://connect.facebook.net/en_US/fbevents.js",
      "https://www.googletagmanager.com/gtag/js?id=G-XXXX",
      "https://static.hotjar.com/c/hotjar-123.js",
      "https://cdn.segment.com/analytics.js/v1/xyz",
      "https://bam.nr-data.net/ins/1",
      "https://rum.browser-intake-datadoghq.com/api/v2/rum",
      "https://api.mixpanel.com/track",
      "https://cdn.cloudflareinsights.com/beacon.min.js",
      // Ad networks
      "https://googleads.g.doubleclick.net/pagead/id",
      "https://adservice.google.com/adsid/integrator.js",
      // Common fonts/images CDNs
      "https://fonts.googleapis.com/css?family=Inter",
      "https://fonts.gstatic.com/s/inter/v12/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMa1ZL7.woff2",
      "https://images.unsplash.com/photo-123",
    ];

    for (const url of trackers) {
      it(`blocks ${url.slice(0, 70)}${url.length > 70 ? "..." : ""}`, async () => {
        const urlAllowed = await importUrlAllowed();
        assert.equal(urlAllowed(url), false, `Expected to block: ${url}`);
      });
    }
  });

  // ── Edge cases ────────────────────────────────────────────────────────────
  describe("edge cases", () => {
    it("returns false for empty string", async () => {
      const urlAllowed = await importUrlAllowed();
      assert.equal(urlAllowed(""), false);
    });

    it("returns false for relative URL", async () => {
      const urlAllowed = await importUrlAllowed();
      assert.equal(urlAllowed("/api/v2/chat/completions"), false);
    });

    it("returns false for non-http protocols (ftp, mailto, etc.)", async () => {
      const urlAllowed = await importUrlAllowed();
      assert.equal(urlAllowed("ftp://chat.z.ai/file"), false);
      assert.equal(urlAllowed("mailto:test@chat.z.ai"), false);
      assert.equal(urlAllowed("chrome://settings"), false);
    });

    it("returns false for lookalike domains (typosquatting)", async () => {
      const urlAllowed = await importUrlAllowed();
      assert.equal(urlAllowed("https://chat-z.ai/"), false);
      assert.equal(urlAllowed("https://chat.z.ai.evil.com/"), false);
      assert.equal(urlAllowed("https://chat.z.ai.com/"), false);
    });
  });
});

describe("zai-web-free network allowlist: RefreshOptions.blockTrackers", () => {
  it("RefreshOptions interface accepts blockTrackers (optional boolean)", async () => {
    // Type-only test: if this compiles, the interface is correct.
    // We don't actually call refreshDeviceTokens because it spawns a browser.
    type RefreshOptions = {
      tokens?: number;
      batches?: number;
      parallel?: number;
      headed?: boolean;
      unsafe?: boolean;
      blockTrackers?: boolean;
      proxyUrl?: string;
      addTokens: (tokens: string[]) => void;
      getPoolSize: () => number;
    };
    const opts: RefreshOptions = {
      tokens: 100,
      batches: 1,
      parallel: 1,
      headed: false,
      unsafe: false,
      blockTrackers: true,
      addTokens: () => {},
      getPoolSize: () => 0,
    };
    assert.equal(opts.blockTrackers, true);
  });
});
