/**
 * Browser-based captcha fallback for Z.AI Free Web.
 *
 * When the fast server-side captcha path fails (device tokens exhausted,
 * stale, or Aliyun rate-limited), this module launches a headless Chromium
 * browser via Playwright, loads chat.z.ai, triggers the captcha flow, and
 * intercepts the browser's POST to /api/v2/chat/completions to extract the
 * `captcha_verify_param`.
 *
 * The browser's chat request is aborted (we only need the captcha param),
 * and the extracted param is used in our own server-side fetch to Z.AI.
 *
 * This is slower (~5-10s per request) but always works as long as
 * Playwright + Chromium are installed.
 *
 * **Performance**: uses `chromiumPerfArgs` (ported from GLM-Free-API Go
 * reference) to disable background throttling, unnecessary services, and
 * automation detection — keeps the renderer hot and avoids IPC storms.
 *
 * **Concurrency**: a single-slot semaphore (`pLimit(1)`) ensures only one
 * Playwright browser launches at a time — prevents OOM under burst load.
 *
 * @module zai-web-free/browser-captcha
 */

import { logger } from "../../utils/logger.ts";
import { urlAllowed } from "./token-collector.ts";

const log = logger("ZAI-WEB-FREE-BROWSER");

const ZAI_URL = "https://chat.z.ai";
const CHAT_COMPLETIONS_PATTERN = "**/api/v2/chat/completions*";

// ── Chromium performance args (ported from GLM-Free-API captcha.go) ──────────
// Disables background throttling, unnecessary services, and automation
// detection — keeps the renderer hot and avoids IPC storms.
const chromiumPerfArgs: string[] = [
  "--disable-blink-features=AutomationControlled",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
  "--disable-ipc-flooding-protection",
  "--disable-background-networking",
  "--disable-default-apps",
  "--disable-extensions",
  "--disable-sync",
  "--disable-translate",
  "--disable-component-update",
  "--disable-client-side-phishing-detection",
  "--disable-hang-monitor",
  "--disable-popup-blocking",
  "--disable-prompt-on-repost",
  "--disable-domain-reliability",
  "--disable-features=Translate,MediaRouter,OptimizationHints",
  "--no-first-run",
  "--no-default-browser-check",
  "--metrics-recording-only",
  "--safebrowsing-disable-auto-update",
  "--password-store=basic",
  "--use-mock-keychain",
];

// ── Network allowlist helper (ported from GLM-Free-API captcha.go commit b100b28)
// Applied by default to every Playwright context used for browser-captcha.
// Blocks trackers/analytics/ads during page load to reduce load time by ~50-60%.
//
// Errors during route setup are non-fatal — captcha collection continues
// without the filter rather than failing the whole request.
async function applyAllowlistToContext(
  context: {
    route(pattern: string, handler: (route: unknown) => Promise<void>): Promise<unknown>;
  },
  blockTrackers: boolean
): Promise<void> {
  if (!blockTrackers) return;
  try {
    await context.route("**/*", async (route: unknown) => {
      const r = route as {
        request(): { url(): string };
        continue(): Promise<void>;
        abort(): Promise<void>;
      };
      if (urlAllowed(r.request().url())) {
        await r.continue();
      } else {
        await r.abort();
      }
    });
  } catch {
    // Non-fatal: continue without filter if route setup fails
  }
}

// ── Single-slot semaphore ────────────────────────────────────────────────────
// Ensures only one Playwright browser launches at a time. Prevents OOM under
// burst load (e.g. 10 concurrent requests all hitting Method B/C fallback).
let _browserLaunchPromise: Promise<unknown> | null = null;

async function withBrowserLock<T>(fn: () => Promise<T>): Promise<T> {
  // Wait for any in-progress browser launch to finish.
  while (_browserLaunchPromise) {
    await _browserLaunchPromise;
  }
  // Mark that we're launching.
  let resolve!: () => void;
  _browserLaunchPromise = new Promise((r) => {
    resolve = r;
  });
  try {
    return await fn();
  } finally {
    _browserLaunchPromise = null;
    resolve();
  }
}

/**
 * Launch a headless Chromium browser, load chat.z.ai, trigger a chat
 * request, and intercept the `captcha_verify_param` from the request body.
 *
 * The browser's actual chat request is aborted — we only extract the
 * captcha param and use it in our own server-side fetch.
 *
 * @returns {Promise<string>} The base64-encoded `captcha_verify_param`.
 * @throws If Playwright is not installed, the page fails to load, or
 *   the captcha param cannot be extracted within 30s.
 */
export async function getCaptchaParamViaBrowser(blockTrackers: boolean = true): Promise<string> {
  return withBrowserLock(async () => {
    // Dynamic import — playwright is a heavy dependency
    const { chromium } = await import("playwright");

    log.info?.("browser_captcha.start", { url: ZAI_URL });

    const browser = await chromium.launch({ headless: true, args: chromiumPerfArgs });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      // Apply network allowlist (default: on) — blocks trackers/analytics/ads
      await applyAllowlistToContext(
        context as unknown as {
          route(p: string, h: (r: unknown) => Promise<void>): Promise<unknown>;
        },
        blockTrackers
      );

      // Intercept the chat completions request to extract captcha_verify_param
      let captchaParam: string | null = null;

      await context.route(CHAT_COMPLETIONS_PATTERN, async (route) => {
        const postData = route.request().postData() || "";
        try {
          const body = JSON.parse(postData);
          if (body.captcha_verify_param) {
            captchaParam = body.captcha_verify_param;
            log.debug?.("browser_captcha.captured", {
              paramLength: captchaParam.length,
            });
          }
        } catch {
          // ignore parse errors
        }
        // Abort the browser's request — we'll send our own
        await route.abort();
      });

      // Load chat.z.ai
      await page.goto(ZAI_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });

      // Wait for UI elements
      await Promise.all([
        page.locator("#model-selector-glm-4_7-button").waitFor({ timeout: 15000 }),
        page.locator("#chat-input").waitFor({ timeout: 15000 }),
      ]);

      // Send a message to trigger the captcha + chat flow
      await page.locator("#chat-input").fill("_");
      await page.locator("#send-message-button").waitFor({ timeout: 5000 });
      await page.locator("#send-message-button").click();

      // Wait for the captcha to be generated and the chat request to fire
      // (max 30s — the captcha SDK auto-resolves for popup mode with no
      // user interaction needed)
      for (let i = 0; i < 30 && !captchaParam; i++) {
        await page.waitForTimeout(1000);
      }

      if (!captchaParam) {
        throw new Error("Browser captcha: could not capture captcha_verify_param within 30s");
      }

      log.info?.("browser_captcha.success", { paramLength: captchaParam.length });
      return captchaParam;
    } finally {
      await browser.close();
    }
  });
}

/**
 * Launch a headless Chromium browser and collect a single fresh device
 * token via `window.z_um.getToken()`. This is used to replenish the
 * device-token pool when the fast path needs fresh tokens.
 *
 * @returns {Promise<string>} A fresh device token.
 * @throws If Playwright is not installed or the page fails to load.
 */
export async function getFreshDeviceTokenViaBrowser(
  blockTrackers: boolean = true
): Promise<string> {
  return withBrowserLock(async () => {
    const { chromium } = await import("playwright");

    log.info?.("fresh_token.start");

    const browser = await chromium.launch({ headless: true, args: chromiumPerfArgs });
    const page = await browser.newPage();

    try {
      // Apply network allowlist (default: on) — blocks trackers/analytics/ads
      try {
        if (blockTrackers) {
          await (
            page as unknown as { route(p: string, h: (r: unknown) => Promise<void>): Promise<void> }
          ).route("**/*", async (route: unknown) => {
            const r = route as {
              request(): { url(): string };
              continue(): Promise<void>;
              abort(): Promise<void>;
            };
            if (urlAllowed(r.request().url())) {
              await r.continue();
            } else {
              await r.abort();
            }
          });
        }
      } catch {
        // Non-fatal
      }

      await page.goto(ZAI_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });

      await Promise.all([
        page.locator("#model-selector-glm-4_7-button").waitFor({ timeout: 15000 }),
        page.locator("#chat-input").waitFor({ timeout: 15000 }),
      ]);

      // Fill and send to initialize the token endpoint
      await page.locator("#chat-input").fill("_");
      await page.locator("#send-message-button").waitFor({ timeout: 5000 });
      await page.locator("#send-message-button").click();

      // Wait for the token endpoint to initialize
      await page.waitForTimeout(7000);

      // Collect a single fresh token
      const token = await page.evaluate(() => {
        const w = window as unknown as { z_um?: { getToken: () => unknown } };
        const tok = w.z_um?.getToken();
        return tok && typeof tok.then === "function" ? tok : Promise.resolve(tok);
      });

      if (!token || typeof token !== "string" || token.length < 10) {
        throw new Error("Browser: failed to get fresh device token");
      }

      log.info?.("fresh_token.success", { tokenLength: token.length });
      return token;
    } finally {
      await browser.close();
    }
  });
}
