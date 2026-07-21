import type { RegistryEntry } from "../../shared.ts";

/**
 * Z.AI Free Web ?�� chat.z.ai consumer web chat (free, captcha-based).
 *
 * This is NOT the official Z.AI API (`api.z.ai/api/anthropic/v1/messages` ?��
 * that's exposed separately as the `zai` provider with `authType: "apikey"`).
 * The free web bridge targets `chat.z.ai/api/v2/chat/completions` and uses:
 *
 *   - Guest JWT auth (free, no API key) ?�� obtained via `/api/v1/auths/guest`
 *   - Aliyun CaptchaV3 verification on every request (in-memory, no browser)
 *   - HMAC-SHA256 request signature (`X-Signature` header)
 *   - Device-token pool (collected via Playwright, consumed FIFO)
 *
 * The user can optionally supply their own Z.AI JWT (`providerSpecificData.token`)
 * to skip guest init and unlock all models (guest sessions only allow glm-4.7).
 *
 * Ported from GLM-Free-API (Go) by izaart95-jpg.
 *
 * Device tokens must be refreshed periodically via the dashboard
 * "Refresh device tokens" button (POST `/api/providers/zai-web-free/refresh-tokens`).
 *
 * ## Live model discovery (PR #7678 pattern)
 *
 * `modelsUrl` + `passthroughModels: true` enables live `/api/models` discovery.
 * The discovery uses the Guest JWT as Bearer (auto-minted via `/api/v1/auths/`).
 * The static `models` array below serves as a fallback when discovery is
 * unavailable or the user has not yet triggered a refresh.
 *
 * **Important caveat**: Guest JWT sessions only allow the `glm-4.7` model.
 * If discovery returns additional models (e.g. glm-5.2, GLM-5.1), they will
 * appear in the catalog but chat requests to them will fail with 403/405.
 * Users who want all models must use the `zai-web-token` sibling provider
 * with their personal Z.AI JWT.
 *
 * Live tests (2026-07-21) confirmed all 5 effort levels
 * (`low|medium|high|xhigh|max`) work on glm-4.7 with Guest JWT -
 * see `docs/i18n/fa/docs/reference/all-providers-thinking-efforts-report.json`.
 */
export const zai_web_freeProvider: RegistryEntry = {
  id: "zai-web-free",
  alias: "zaifree",
  format: "openai",
  executor: "zai-web-free",
  baseUrl: "https://chat.z.ai",
  chatPath: "/api/v2/chat/completions",
  modelsUrl: "https://chat.z.ai/api/models", // Live discovery (PR #7678 pattern)
  authType: "none", // Auth handled inside the executor (guest JWT + captcha)
  authHeader: "none",
  forceStream: true, // Z.AI always streams; non-stream clients get a buffered JSON
  passthroughModels: true, // Live /api/models discovery is authoritative (with fallback)
  models: [
    {
      id: "glm-4.7",
      name: "GLM 4.7 (Free, Guest)",
      contextLength: 131072,
      maxOutputTokens: 8192,
      supportsReasoning: true,
    },
  ],
};
