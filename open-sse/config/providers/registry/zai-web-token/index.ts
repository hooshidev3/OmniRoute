import type { RegistryEntry } from "../../shared.ts";

/**
 * Z.AI Token Web — chat.z.ai consumer web chat with user-supplied JWT.
 *
 * This is a sibling of `zai-web-free` that uses a user-supplied Z.AI JWT
 * instead of a guest session. The JWT unlocks all models (GLM-5.2, GLM-5.1,
 * GLM-5-Turbo, GLM-5v-Turbo, glm-4.7) instead of just glm-4.7.
 *
 * The user obtains the JWT from chat.z.ai → DevTools → Application → Local
 * Storage → key "token". It's pasted into the credential field and stored
 * in `providerSpecificData.token`.
 *
 * Same executor (`zai-web-free`) — the executor checks for
 * `providerSpecificData.token` and, if present, skips guest init and uses
 * the supplied JWT directly. The captcha + signature flow is identical.
 *
 * Auth: `kind: "token"` (JWT, not cookie) — displayed in the Web Cookie
 * Providers section of the dashboard because it's a web-session credential
 * (not an API key for the official api.z.ai endpoint).
 *
 * ## Live model discovery (PR #7678 pattern)
 *
 * `passthroughModels: true` enables live `/api/models` discovery via the
 * PROVIDER_MODELS_CONFIG entry in
 * `src/app/api/providers/[id]/models/discovery/providerModelsConfig.ts`.
 * The static `models` array below serves as a fallback when discovery is
 * unavailable (e.g., the dashboard hasn't fetched yet, or the endpoint is
 * unreachable).
 *
 * When discovery succeeds, the response is normalized into
 * `SyncedAvailableModel` records (DB-backed) which carry
 * `supportedThinkingEfforts` and `defaultThinkingEffort` fields if the
 * upstream exposes them. The catalog builder
 * (`src/app/api/v1/models/catalog.ts`) then surfaces those effort tiers
 * as `capabilities.effort_tiers`, and `syncedEffortVariants.ts`
 * synthesizes per-tier catalog entries (e.g. `zai-web-token/glm-5.2-max`).
 *
 * Live tests (2026-07-21) confirmed all 5 effort levels
 * (`low|medium|high|xhigh|max`) work on glm-4.7, GLM-5.1, and glm-5.2 —
 * see `zai-thinking-efforts-final-report.json` for the full matrix.
 *
 * UNVERIFIED: same caveat as `zai-web` upstream (PR #7678) — the exact
 * response shape of `https://chat.z.ai/api/models` and whether bare Bearer
 * auth (vs the full Cookie header chat-completions requires) is accepted
 * must be confirmed against a real account. If discovery fails, the static
 * fallback below is used.
 */
export const zai_web_tokenProvider: RegistryEntry = {
  id: "zai-web-token",
  alias: "zaitoken",
  format: "openai",
  executor: "zai-web-free", // Reuses the same executor — it checks for hardcodedToken
  baseUrl: "https://chat.z.ai",
  chatPath: "/api/v2/chat/completions",
  modelsUrl: "https://chat.z.ai/api/models", // Live discovery (PR #7678 pattern)
  authType: "token", // User-supplied JWT
  authHeader: "bearer",
  forceStream: true, // Z.AI always streams; non-stream clients get a buffered JSON
  passthroughModels: true, // Live /api/models discovery is authoritative (with fallback)
  models: [
    {
      id: "glm-5.2",
      name: "GLM 5.2",
      contextLength: 131072,
      maxOutputTokens: 8192,
      supportsReasoning: true,
    },
    {
      id: "GLM-5.1",
      name: "GLM 5.1",
      contextLength: 131072,
      maxOutputTokens: 8192,
      supportsReasoning: true,
    },
    {
      id: "GLM-5-Turbo",
      name: "GLM 5 Turbo",
      contextLength: 131072,
      maxOutputTokens: 8192,
    },
    {
      id: "GLM-5v-Turbo",
      name: "GLM 5V Turbo (Vision)",
      contextLength: 131072,
      maxOutputTokens: 8192,
      supportsVision: true,
    },
    {
      id: "glm-4.7",
      name: "GLM 4.7",
      contextLength: 131072,
      maxOutputTokens: 8192,
      supportsReasoning: true,
    },
  ],
};
