/**
 * Feature flag for the zai-web-free provider.
 *
 * Default: ENABLED (true). Operators can disable the provider by setting
 * either of two env vars:
 *
 *   OMNIROUTE_ZAI_WEB_FREE_DISABLED=1   # truthy → disabled
 *   OMNIROUTE_ZAI_WEB_FREE_ENABLED=0    # falsy → disabled
 *
 * The DISABLED flag takes precedence. When disabled:
 *   - The executor returns 503 with an explanatory message (no captcha
 *     attempt, no pool consumption).
 *   - The Playwright refresh endpoint refuses to run (saves resources).
 *   - The pool-status / keys / prerequisites endpoints still work so
 *     operators can inspect state.
 *
 * @module zai-web-free/feature-flag
 */

const TRUTHY = /^(1|true|yes|on)$/i;

/**
 * Returns `true` when the zai-web-free provider is *disabled* by env.
 * Default state is enabled — both env vars absent → returns false.
 */
export function isZaiWebFreeDisabled(): boolean {
  // DISABLED flag — truthy means disabled
  const disabled = process.env.OMNIROUTE_ZAI_WEB_FREE_DISABLED;
  if (typeof disabled === "string" && TRUTHY.test(disabled.trim())) {
    return true;
  }
  // ENABLED flag — falsy means disabled (only acts when explicitly set)
  const enabled = process.env.OMNIROUTE_ZAI_WEB_FREE_ENABLED;
  if (typeof enabled === "string" && enabled.trim() !== "" && !TRUTHY.test(enabled.trim())) {
    return true;
  }
  return false;
}

/**
 * Returns `true` when the zai-web-free provider is enabled (default).
 * Convenience wrapper for callers that prefer positive semantics.
 */
export function isZaiWebFreeEnabled(): boolean {
  return !isZaiWebFreeDisabled();
}
