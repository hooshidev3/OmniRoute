/**
 * Xiaomi MiMo AI Studio web chat (cookie-based).
 *
 * Auth: three browser cookies (serviceToken, userId, xiaomichatbot_ph)
 * pasted as the full Cookie header from aistudio.xiaomimimo.com.
 *
 * Model capabilities are hardcoded in the registry based on MiMo's
 * /open-apis/bot/config endpoint. When MiMo adds new models, update
 * the models array below.
 *
 * The executor handles:
 *   - <think>...</think> reasoning tag separation via shared thinkModeProcessor
 *   - (citation:N) marker stripping (with cross-chunk buffering)
 *   - Tool calling via OmniRoute native <tool>{json}</tool> protocol
 *   - Conversation lifecycle: /conversation/save -> /bot/chat -> genTitle
 *     -> optional /conversation/delete (only for one-shot, not reused)
 *   - Multi-turn continuity via providerSessionRegistry
 *
 * Think mode is configurable via:
 *   - Per-request: x-omniroute-think-mode header (passthrough | strip | separate)
 *   - Per-connection: providerSpecificData.requestDefaults.thinkMode
 *   - Global: settings.thinkOutputMode (default: separate)
 *
 * Headers: default headers are used as-is. Users can override any header
 * via providerSpecificData.customHeaders from the dashboard.
 */
export const xiaomimimo_webProvider: RegistryEntry = {
  id: "xiaomimimo-web",
  alias: "mimo-web",
  format: "openai",
  executor: "xiaomimimo-web",
  baseUrl: "https://aistudio.xiaomimimo.com",
  chatPath: "/open-apis/bot/chat",
  authType: "cookie",
  authHeader: "none",
  forceStream: true, // upstream always streams; non-stream clients get a buffered JSON response
  models: [
    {
      id: "mimo-v2.5-pro",
      name: "MiMo-V2.5-Pro",
      contextLength: 1048576,
      maxOutputTokens: 131072,
      supportsReasoning: true,
      toolCalling: true,
    },
    {
      id: "mimo-v2.5",
      name: "MiMo-V2.5",
      contextLength: 1048576,
      maxOutputTokens: 131072,
      toolCalling: true,
    },
    {
      id: "mimo-v2-flash",
      name: "MiMo-V2-Flash",
      contextLength: 262144,
      maxOutputTokens: 65536,
      toolCalling: true,
    },
  ],
};
