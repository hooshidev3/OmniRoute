/**
 * Z.AI device-token collector - Playwright-based token farm.
 *
 * Ported from GLM-Free-API's init.go. Visits https://chat.z.ai in a headless
 * Chromium browser, fills the chat input with a placeholder, waits for the
 * token endpoint to initialize, then extracts `window.z_um.getToken()` values.
 *
 * `playwright` is imported dynamically so it doesn't add to server startup
 * time - only loaded when the refresh endpoint is actually called.
 *
 * ## Network Allowlist (ported from GLM-Free-API captcha.go commit b100b28)
 *
 * By default, a surgical URL filter is applied to the Playwright page: only
 * requests to chat.z.ai itself, the Aliyun Captcha script, and a small set
 * of captcha-related CDN endpoints are allowed. All other requests
 * (analytics, trackers, ads, fonts, images) are aborted. This reduces page
 * load time by ~50-60% and cuts bandwidth by ~80%.
 *
 * The filter is **on by default**. Operators can disable it from the dashboard
 * by passing `blockTrackers: false` to `refreshDeviceTokens()` (e.g. if a CDN
 * changes and the allowlist becomes too strict, the dashboard toggle lets
 * operators fall back to unfiltered browsing without a code change).
 *
 * @module zai-web-free/token-collector
 */

const ZAI_URL = "https://chat.z.ai";

// Normal mode limits (matching GLM-Free-API captcha.go commits 7dc4ded + 1d0d4b5)
const MAX_TOKENS = 1500;
const UNSAFE_MAX_TOKENS = 1500;
const DEFAULT_TOKENS = 850;
const DEFAULT_BATCH = 5;
const MAX_BATCH = 9;
const UNSAFE_MAX_BATCH = 25;
const SEND_WAIT_MS = 10000;
const MAX_RETRIES = 3;
const TOKEN_COLLECTION_TIMEOUT_MS = 90_000;
const MAX_PARALLEL = 3;
const UNSAFE_MAX_PARALLEL = 5;

// ── Network allowlist (ported from GLM-Free-API captcha.go commit b100b28) ───
// Surgical URL filter - blocks trackers/analytics/ads during token collection
// to reduce page-load time and bandwidth.
//
// Pre-compiled regex patterns for wildcard rules only. Simple prefix/exact
// rules use string startsWith / === (no regex overhead).
const RE_Z_CDN =
  /^https:\/\/z-cdn\.chatglm\.cn\/z-ai\/frontend\/prod-fe-[^/]+\/assets\/index-[^/]+\.js$/;
const RE_CLOUD_AUTH = /^https:\/\/cloudauth-device-dualstack\.[^/]*aliyuncs\.com\//;
const RE_FEILIN =
  /^https:\/\/g\.alicdn\.com\/captcha-frontend\/FeiLin\/[^/]+\/feilin[^/]*\.[^/]*\.js$/;

/**
 * Check a URL against the network allowlist.
 *
 * Five URL categories are allowed (matches the Go reference implementation):
 *   1. https://chat.z.ai/ (and wss:// for WebSocket upgrades)
 *   2. https://z-cdn.chatglm.cn/z-ai/frontend/prod-fe-X/assets/index-Y.js
 *      (X and Y are wildcards matched by RE_Z_CDN)
 *   3. https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js
 *      (exact match, no regex)
 *   4. https://cloudauth-device-dualstack.REGION.aliyuncs.com/
 *      (REGION is a wildcard matched by RE_CLOUD_AUTH)
 *   5. https://g.alicdn.com/captcha-frontend/FeiLin/VERSION/feilinNAME.EXT.js
 *      (VERSION, NAME, EXT are wildcards matched by RE_FEILIN)
 *
 * Fast path: prefix checks via `startsWith` (~5 ns each).
 * Slow path: regex only for wildcard patterns (3 of 5 rules).
 * Switch short-circuits on first match - most requests are decided in
 * O(prefix_length) without ever touching the regex engine.
 *
 * Pure and unit-testable. Exported for testing.
 */
export function urlAllowed(u: string): boolean {
  // 1. Entire chat.z.ai domain - also allow wss:// for WebSocket upgrades
  if (u.startsWith("https://chat.z.ai/") || u.startsWith("wss://chat.z.ai/")) return true;
  // 2. z-cdn build assets (prefix filter -> regex confirm)
  if (u.startsWith("https://z-cdn.chatglm.cn/z-ai/frontend/prod-fe-") && RE_Z_CDN.test(u))
    return true;
  // 3. Exact Aliyun captcha script (string equality, no regex)
  if (u === "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js") return true;
  // 4. cloudauth-device-dualstack.*.aliyuncs.com (prefix filter -> regex confirm)
  if (u.startsWith("https://cloudauth-device-dualstack.") && RE_CLOUD_AUTH.test(u)) return true;
  // 5. FeiLin captcha assets (prefix filter -> regex confirm)
  if (u.startsWith("https://g.alicdn.com/captcha-frontend/FeiLin/") && RE_FEILIN.test(u))
    return true;
  return false;
}

type PlaywrightRoute = {
  request(): { url(): string };
  continue(): Promise<void>;
  abort(): Promise<void>;
};

/**
 * Apply the network allowlist to a Playwright page.
 *
 * When `blockTrackers` is true (default), every request not on the allowlist
 * is aborted. When false, the page is left unfiltered.
 *
 * Errors during route setup are non-fatal - token collection continues
 * without the filter rather than failing the whole refresh.
 */
async function applyNetworkAllowlist(page: PlaywrightPage, blockTrackers: boolean): Promise<void> {
  if (!blockTrackers) return;
  try {
    await page.route("**/*", async (route: PlaywrightRoute) => {
      if (urlAllowed(route.request().url())) {
        await route.continue();
      } else {
        await route.abort();
      }
    });
  } catch {
    // Non-fatal: continue without filter if route setup fails
  }
}

/** Resolved limits based on the `unsafe` flag. */
interface CollectionLimits {
  maxTokens: number;
  maxBatch: number;
  maxParallel: number;
}

function resolveLimits(unsafe: boolean): CollectionLimits {
  return unsafe
    ? { maxTokens: UNSAFE_MAX_TOKENS, maxBatch: UNSAFE_MAX_BATCH, maxParallel: UNSAFE_MAX_PARALLEL }
    : { maxTokens: MAX_TOKENS, maxBatch: MAX_BATCH, maxParallel: MAX_PARALLEL };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type PlaywrightPage = {
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
  locator(selector: string): {
    waitFor(options?: Record<string, unknown>): Promise<void>;
    fill(value: string): Promise<void>;
    click(options?: Record<string, unknown>): Promise<void>;
  };
  evaluate<T>(fn: (args: unknown) => T | Promise<T>, arg?: unknown): Promise<T>;
  waitForTimeout(ms: number): Promise<void>;
  close(): Promise<void>;
  route(pattern: string, handler: (route: PlaywrightRoute) => Promise<void>): Promise<void>;
};
type PlaywrightBrowser = {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
};

/**
 * Create a worker page with optional route allowlist.
 * Route handlers persist across reloads on the same page, so the allowlist is
 * installed exactly once at page creation rather than per batch.
 * Ported from GLM-Free-API captcha.go commit 6223816.
 */
async function newWorkerPage(
  browser: PlaywrightBrowser,
  blockTrackers: boolean = true
): Promise<PlaywrightPage> {
  const page = await browser.newPage();
  await applyNetworkAllowlist(page, blockTrackers);
  return page;
}

/**
 * Collect `total` device tokens from a single browser page.
 * The page is reused across batches; route handlers (if any) were installed
 * once at page creation in newWorkerPage. Each call here force-reloads
 * the page by re-navigating to URL.
 */
async function collectTokensOnPage(
  page: PlaywrightPage,
  total: number,
  blockTrackers: boolean = true
): Promise<string[]> {
  // Apply network allowlist before navigation (default: on)
  // Only applies if not already installed on the page (newWorkerPage does this once).
  await applyNetworkAllowlist(page, blockTrackers);

  await page.goto(ZAI_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  // Wait for both UI elements in parallel
  const results = await Promise.allSettled([
    page.locator("#model-selector-glm-4_7-button").waitFor({ timeout: 15000 }),
    page.locator("#chat-input").waitFor({ timeout: 15000 }),
  ]);
  if (results[0].status === "rejected") {
    throw new Error(`model button not found: ${results[0].reason?.message || results[0].reason}`);
  }
  if (results[1].status === "rejected") {
    throw new Error(`textarea not found: ${results[1].reason?.message || results[1].reason}`);
  }

  const textarea = page.locator("#chat-input");
  await textarea.fill("__");

  const sendBtn = page.locator("#send-message-button");
  await sendBtn.waitFor({ timeout: 5000 });
  await sendBtn.click();

  await sleep(SEND_WAIT_MS);

  const collectPromise = page.evaluate(
    async (args: { total: number }) => {
      const total = args.total;
      const out = new Array(total);
      for (let i = 0; i < total; i++) {
        const tok = (window as unknown as { z_um: { getToken: () => unknown } }).z_um.getToken();
        out[i] = tok && typeof tok.then === "function" ? await tok : tok;
        if (i % 50 === 0) {
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      return out;
    },
    { total }
  );

  const tokens = await Promise.race([
    collectPromise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(`token collection timed out after ${TOKEN_COLLECTION_TIMEOUT_MS / 1000}s`)
          ),
        TOKEN_COLLECTION_TIMEOUT_MS
      )
    ),
  ]);

  return (tokens || []).filter((t: unknown) => typeof t === "string" && (t as string).length > 0);
}

/**
 * Run a single batch with retries.
 * Reuses the given page across batches; collectTokensOnPage force-reloads it
 * on every call (and on every retry) by re-navigating to URL.
 * Ported from GLM-Free-API captcha.go commit 6223816.
 */
async function runBatch(
  page: PlaywrightPage,
  total: number,
  batchNum: number,
  blockTrackers: boolean = true
): Promise<string[]> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const tokens = await collectTokensOnPage(page, total, blockTrackers);
      return tokens;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `batch ${batchNum} failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
  );
}

export interface RefreshOptions {
  tokens?: number;
  batches?: number;
  parallel?: number;
  headed?: boolean;
  /**
   * When true, raises limits to match GLM-Free-API's `--unsafe` flag:
   *   - Max tokens per batch: 1250 ?�� 1500
   *   - Max batches: 9 ?�� 25
   *   - Max parallel workers: 3 ?�� 5
   *
   * WARNING: unsafe mode collects up to 37,500 tokens in a single run (1500 ?� 25).
   * This increases the risk of Z.AI flagging the browser fingerprint as suspicious
   * and temporarily banning the IP. Only use when the pool is critically low and
   * you need a large replenishment in one shot.
   */
  unsafe?: boolean;
  /**
   * Optional proxy URL for the Playwright browser. Supports HTTP, HTTPS, and
   * SOCKS5 proxies. Format: `http://user:pass@host:port` or `socks5://host:port`.
   * When set, the browser routes all traffic (chat.z.ai page load + token
   * extraction) through this proxy. This is separate from RouteChi's
   * per-connection proxy (which covers the executor's fetch calls) ?�� Playwright
   * has its own network stack and needs an explicit `--proxy-server` flag.
   */
  proxyUrl?: string;
  /**
   * When true (default), apply the network allowlist to block trackers,
   * analytics, and ads during Playwright token collection. This reduces
   * page-load time by ~50-60% and bandwidth by ~80%.
   *
   * Operators can disable it from the dashboard if a CDN changes and the
   * allowlist becomes too strict (rare).
   */
  blockTrackers?: boolean;
  addTokens: (tokens: string[]) => void;
  getPoolSize: () => number;
}

export interface RefreshResult {
  collected: number;
  poolSize: number;
  /** The limits that were actually applied (reflects the `unsafe` flag). */
  limits: CollectionLimits;
}

/**
 * Run a full device-token collection session.
 *
 * Dynamically imports `playwright` (so it's only loaded when needed), launches
 * Chromium, and collects tokens across N batches. Each batch opens a fresh
 * page, fills the chat input, waits for the token endpoint, and extracts
 * `window.z_um.getToken()` values.
 *
 * When `unsafe` is true, the per-batch/batch-count/parallel limits are raised
 * to match GLM-Free-API's `--unsafe` flag (1500 tokens, 25 batches, 5 parallel).
 *
 * @returns {Promise<RefreshResult>} The number of tokens collected, the
 *   resulting pool size, and the limits that were applied.
 */
export async function refreshDeviceTokens(options: RefreshOptions): Promise<RefreshResult> {
  const limits = resolveLimits(options.unsafe ?? false);
  const tokenCount = Math.min(options.tokens ?? DEFAULT_TOKENS, limits.maxTokens);
  const batchCount = Math.min(options.batches ?? DEFAULT_BATCH, limits.maxBatch);
  const parallel = Math.min(options.parallel ?? 1, limits.maxParallel);
  const headed = options.headed ?? false;
  const proxyUrl = options.proxyUrl;
  const blockTrackers = options.blockTrackers ?? true; // default: on
  const addTokens = options.addTokens;
  const getPoolSize = options.getPoolSize;

  // Dynamic import ?�� playwright is a heavy dependency, only load when refreshing
  const { chromium } = await import("playwright");

  // Playwright has its own network stack (separate from Node's fetch), so the
  // patched globalThis.fetch proxy doesn't apply. Pass the proxy explicitly
  // to chromium.launch() when a proxyUrl is configured.
  const launchOptions: Record<string, unknown> = { headless: !headed };
  if (proxyUrl) {
    // Playwright accepts proxy config as { server, username?, password? }
    // Parse the URL to extract auth components if present.
    try {
      const parsed = new URL(proxyUrl);
      const proxyConfig: Record<string, string> = {
        server: `${parsed.protocol}//${parsed.hostname}:${parsed.port || (parsed.protocol === "https:" ? "443" : "1080")}`,
      };
      if (parsed.username) proxyConfig.username = decodeURIComponent(parsed.username);
      if (parsed.password) proxyConfig.password = decodeURIComponent(parsed.password);
      launchOptions.proxy = proxyConfig;
    } catch {
      // If the URL is malformed, pass it as-is to Playwright's server field
      launchOptions.proxy = { server: proxyUrl };
    }
  }

  const browser = await chromium.launch(launchOptions as Parameters<typeof chromium.launch>[0]);
  try {
    const allTokens: string[] = [];

    if (parallel > 1 && batchCount > 1) {
      // Each worker keeps ONE page open for all its batches; every batch
      // force-reloads the page instead of opening a new one and closing
      // the old one. Ported from GLM-Free-API captcha.go commit 6223816.
      const batchQueue: number[] = [];
      for (let b = 1; b <= batchCount; b++) batchQueue.push(b);
      const workers: Promise<void>[] = [];
      for (let w = 0; w < parallel; w++) {
        workers.push(
          (async () => {
            const page = await newWorkerPage(browser, blockTrackers);
            try {
              while (batchQueue.length > 0) {
                const batchNum = batchQueue.shift();
                if (batchNum === undefined) break;
                const tokens = await runBatch(page, tokenCount, batchNum, blockTrackers);
                addTokens(tokens);
                allTokens.push(...tokens);
              }
            } finally {
              await page.close().catch(() => {});
            }
          })()
        );
      }
      await Promise.all(workers);
    } else {
      // Sequential: keep ONE page open across all batches.
      const page = await newWorkerPage(browser, blockTrackers);
      try {
        for (let b = 1; b <= batchCount; b++) {
          const tokens = await runBatch(page, tokenCount, b, blockTrackers);
          addTokens(tokens);
          allTokens.push(...tokens);
        }
      } finally {
        await page.close().catch(() => {});
      }
    }

    return { collected: allTokens.length, poolSize: getPoolSize(), limits };
  } finally {
    await browser.close();
  }
}
