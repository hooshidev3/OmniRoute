/**
 * TDD regression for zai-web-free live model discovery — mirrors the
 * zai-web-token discovery test but with Guest JWT semantics.
 *
 * `zai-web-free` is the no-auth sibling of `zai-web-token`. It uses an
 * auto-minted Guest JWT (via /api/v1/auths/) instead of a user-supplied
 * JWT. The discovery config mints a Guest JWT on-the-fly in `buildHeaders`
 * (cached for 23h) and uses the same `parseZaiWebFreeDiscoveryResponse`
 * parser as `zai-web-token`, but with `owned_by: "zai-web-free"` default.
 *
 * Live tests (2026-07-21) confirmed all 5 effort levels (low|medium|high|
 * xhigh|max) work on glm-4.7 (the only Guest-JWT-accessible model) — see
 * `docs/i18n/fa/docs/reference/all-providers-thinking-efforts-report.json`.
 *
 * Same UNVERIFIED caveat as PR #7678: the exact response shape of
 * `https://chat.z.ai/api/models` and whether bare Bearer auth (vs the
 * full Cookie header chat-completions requires) is accepted must be
 * confirmed against a real account. If discovery fails, the static
 * fallback model (glm-4.7) is used.
 */
import test from "node:test";
import assert from "node:assert/strict";

test("zai-web-free has a PROVIDER_MODELS_CONFIG entry with async buildHeaders", async () => {
  const mod = await import(
    "../../src/app/api/providers/[id]/models/discovery/providerModelsConfig.ts"
  );
  const config = (mod as { PROVIDER_MODELS_CONFIG?: Record<string, unknown> })
    .PROVIDER_MODELS_CONFIG;
  assert.ok(config, "PROVIDER_MODELS_CONFIG should be exported");
  assert.ok(
    (config as Record<string, unknown>)["zai-web-free"],
    "zai-web-free should have a PROVIDER_MODELS_CONFIG entry"
  );
  const entry = (config as Record<string, { url?: string; method?: string; buildHeaders?: unknown; parseResponse?: unknown }>)[
    "zai-web-free"
  ];
  assert.equal(entry.url, "https://chat.z.ai/api/models");
  assert.equal(entry.method, "GET");
  assert.equal(typeof entry.parseResponse, "function");
  assert.equal(typeof entry.buildHeaders, "function");
});

test("zai-web-free registry entry has modelsUrl + passthroughModels", async () => {
  const { REGISTRY } = await import("../../open-sse/config/providers/index.ts");
  const entry = REGISTRY["zai-web-free"];
  assert.ok(entry, "zai-web-free should be in REGISTRY");
  assert.equal(
    entry.modelsUrl,
    "https://chat.z.ai/api/models",
    "modelsUrl should point at chat.z.ai/api/models"
  );
  assert.equal(
    entry.passthroughModels,
    true,
    "passthroughModels should be true (live discovery is authoritative)"
  );
  // Static fallback model should still be present (glm-4.7 only for Guest JWT)
  assert.ok(entry.models.length >= 1, "should have at least 1 static fallback model");
  assert.equal(entry.models[0].id, "glm-4.7");
});

test("parseResponse for zai-web-free uses owned_by='zai-web-free' default", async () => {
  const mod = await import(
    "../../src/app/api/providers/[id]/models/discovery/providerModelsConfig.ts"
  );
  const config = (mod as { PROVIDER_MODELS_CONFIG?: Record<string, { parseResponse: (d: unknown) => Record<string, unknown>[] }> })
    .PROVIDER_MODELS_CONFIG;
  const entry = config["zai-web-free"];
  const sampleResponse = {
    data: {
      data: [
        { id: "glm-4.7", name: "GLM 4.7" }, // no owned_by — should default to zai-web-free
        { id: "glm-5.2", name: "GLM 5.2", owned_by: "zai" }, // upstream owned_by preserved
      ],
    },
  };
  const parsed = entry.parseResponse(sampleResponse);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].owned_by, "zai-web-free"); // default
  assert.equal(parsed[1].owned_by, "zai"); // preserved
});

test("parseResponse for zai-web-free preserves supportedThinkingEfforts", async () => {
  const mod = await import(
    "../../src/app/api/providers/[id]/models/discovery/providerModelsConfig.ts"
  );
  const config = (mod as { PROVIDER_MODELS_CONFIG?: Record<string, { parseResponse: (d: unknown) => Record<string, unknown>[] }> })
    .PROVIDER_MODELS_CONFIG;
  const entry = config["zai-web-free"];
  const sampleResponse = {
    data: {
      data: [
        {
          id: "glm-4.7",
          name: "GLM 4.7",
          supportedThinkingEfforts: ["low", "medium", "high", "xhigh", "max"],
        },
      ],
    },
  };
  const parsed = entry.parseResponse(sampleResponse);
  assert.deepEqual(parsed[0].supportedThinkingEfforts, [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
});

test("zai-web-free and zai-web-token use independent parsers (different owned_by defaults)", async () => {
  const mod = await import(
    "../../src/app/api/providers/[id]/models/discovery/providerModelsConfig.ts"
  );
  const config = (mod as { PROVIDER_MODELS_CONFIG?: Record<string, { parseResponse: (d: unknown) => Record<string, unknown>[] }> })
    .PROVIDER_MODELS_CONFIG;
  const sample = {
    data: { data: [{ id: "glm-4.7", name: "GLM 4.7" }] },
  };
  const freeParsed = config["zai-web-free"].parseResponse(sample);
  const tokenParsed = config["zai-web-token"].parseResponse(sample);
  assert.equal(freeParsed[0].owned_by, "zai-web-free");
  assert.equal(tokenParsed[0].owned_by, "zai-web-token");
});
