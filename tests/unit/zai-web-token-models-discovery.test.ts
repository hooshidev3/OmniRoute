/**
 * TDD regression for zai-web-token live model discovery — mirrors the
 * `zai-web-models-discovery-7678.test.ts` pattern but for the JWT-based
 * sibling provider.
 *
 * `zai-web-token` is the user-supplied-JWT variant of `zai-web-free`. It
 * reuses the same executor but its credential field is a raw JWT (no
 * `token=` prefix, no Cookie header). The discovery config therefore
 * passes the JWT directly as `Authorization: Bearer <jwt>` instead of
 * calling `extractZaiToken()` first.
 *
 * Live tests (2026-07-21, see zai-thinking-efforts-final-report.json)
 * confirmed all 5 effort levels (low|medium|high|xhigh|max) work on
 * glm-4.7, GLM-5.1, glm-5.2 — the parseResponse helper here preserves
 * any `supportedThinkingEfforts`/`defaultThinkingEffort` fields the
 * upstream exposes so the catalog builder + syncedEffortVariants.ts can
 * surface them as `capabilities.effort_tiers` and per-tier catalog
 * entries (e.g. `zai-web-token/glm-5.2-max`).
 *
 * Same UNVERIFIED caveat as PR #7678: the exact response shape of
 * `https://chat.z.ai/api/models` and whether bare Bearer auth (vs the
 * full Cookie header chat-completions requires) is accepted must be
 * confirmed against a real account. These tests prove the pipeline
 * (auth-header construction, parsing, effort-tier pass-through, fallback)
 * against the assumed response shape; they are not a substitute for the
 * mandatory live check.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-zwt-disc-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const modelsRoute = await import("../../src/app/api/providers/[id]/models/route.ts");

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

interface ModelsBody {
  provider: string;
  connectionId?: number;
  providerSpecificData?: Record<string, unknown>;
}

async function callModelsRoute(body: ModelsBody, token: string) {
  const req = new Request("http://localhost/api/providers/0/models", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": token },
    body: JSON.stringify(body),
  });
  const res = await modelsRoute.POST(req);
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

test("zai-web-token has a PROVIDER_MODELS_CONFIG entry", async () => {
  const mod = await import(
    "../../src/app/api/providers/[id]/models/discovery/providerModelsConfig.ts"
  );
  // The config is exported as PROVIDER_MODELS_CONFIG (or similar)
  const config = (mod as { PROVIDER_MODELS_CONFIG?: Record<string, unknown> })
    .PROVIDER_MODELS_CONFIG;
  assert.ok(config, "PROVIDER_MODELS_CONFIG should be exported");
  assert.ok(
    (config as Record<string, unknown>)["zai-web-token"],
    "zai-web-token should have a PROVIDER_MODELS_CONFIG entry"
  );
  const entry = (config as Record<string, { url?: string; method?: string; parseResponse?: unknown }>)[
    "zai-web-token"
  ];
  assert.equal(entry.url, "https://chat.z.ai/api/models");
  assert.equal(entry.method, "GET");
  assert.equal(typeof entry.parseResponse, "function");
});

test("zai-web-token registry entry has modelsUrl + passthroughModels", async () => {
  const { REGISTRY } = await import("../../open-sse/config/providers/index.ts");
  const entry = REGISTRY["zai-web-token"];
  assert.ok(entry, "zai-web-token should be in REGISTRY");
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
  // Static fallback models should still be present
  assert.ok(entry.models.length >= 5, "should have at least 5 static fallback models");
});

test("parseResponse extracts id/name/owned_by from {data: {data: [...]}} shape", async () => {
  const mod = await import(
    "../../src/app/api/providers/[id]/models/discovery/providerModelsConfig.ts"
  );
  const config = (mod as { PROVIDER_MODELS_CONFIG?: Record<string, { parseResponse: (d: unknown) => unknown[] }> })
    .PROVIDER_MODELS_CONFIG;
  const entry = config["zai-web-token"];
  const sampleResponse = {
    data: {
      data: [
        { id: "glm-5.2", name: "GLM 5.2", owned_by: "zai" },
        { id: "GLM-5.1", name: "GLM 5.1", owned_by: "zai" },
        { id: "glm-4.7", name: "GLM 4.7" },
      ],
    },
  };
  const parsed = entry.parseResponse(sampleResponse);
  assert.equal(parsed.length, 3);
  // Upstream owned_by is preserved
  assert.equal(parsed[0].id, "glm-5.2");
  assert.equal(parsed[0].name, "GLM 5.2");
  assert.equal(parsed[0].owned_by, "zai");
  // owned_by defaults to "zai-web-token" when missing
  assert.equal(parsed[2].owned_by, "zai-web-token");
});

test("parseResponse handles flatter {data: [...]} shape", async () => {
  const mod = await import(
    "../../src/app/api/providers/[id]/models/discovery/providerModelsConfig.ts"
  );
  const config = (mod as { PROVIDER_MODELS_CONFIG?: Record<string, { parseResponse: (d: unknown) => unknown[] }> })
    .PROVIDER_MODELS_CONFIG;
  const entry = config["zai-web-token"];
  const sampleResponse = {
    data: [
      { id: "glm-5.2", name: "GLM 5.2" },
      { id: "GLM-5.1", name: "GLM 5.1" },
    ],
  };
  const parsed = entry.parseResponse(sampleResponse);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].id, "glm-5.2");
});

test("parseResponse preserves supportedThinkingEfforts when present", async () => {
  const mod = await import(
    "../../src/app/api/providers/[id]/models/discovery/providerModelsConfig.ts"
  );
  const config = (mod as { PROVIDER_MODELS_CONFIG?: Record<string, { parseResponse: (d: unknown) => Record<string, unknown>[] }> })
    .PROVIDER_MODELS_CONFIG;
  const entry = config["zai-web-token"];
  const sampleResponse = {
    data: {
      data: [
        {
          id: "glm-5.2",
          name: "GLM 5.2",
          supportedThinkingEfforts: ["low", "medium", "high", "xhigh", "max"],
          defaultThinkingEffort: "high",
        },
      ],
    },
  };
  const parsed = entry.parseResponse(sampleResponse);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0].supportedThinkingEfforts, [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.equal(parsed[0].defaultThinkingEffort, "high");
});

test("parseResponse extracts supportedThinkingEfforts from nested reasoning.supported_efforts (#7694 shape)", async () => {
  const mod = await import(
    "../../src/app/api/providers/[id]/models/discovery/providerModelsConfig.ts"
  );
  const config = (mod as { PROVIDER_MODELS_CONFIG?: Record<string, { parseResponse: (d: unknown) => Record<string, unknown>[] }> })
    .PROVIDER_MODELS_CONFIG;
  const entry = config["zai-web-token"];
  const sampleResponse = {
    data: {
      data: [
        {
          id: "glm-5.2",
          name: "GLM 5.2",
          reasoning: {
            supported_efforts: ["low", "high", "max"],
            default_effort: "high",
          },
        },
      ],
    },
  };
  const parsed = entry.parseResponse(sampleResponse);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0].supportedThinkingEfforts, ["low", "high", "max"]);
  assert.equal(parsed[0].defaultThinkingEffort, "high");
});

test("parseResponse filters out non-string effort values", async () => {
  const mod = await import(
    "../../src/app/api/providers/[id]/models/discovery/providerModelsConfig.ts"
  );
  const config = (mod as { PROVIDER_MODELS_CONFIG?: Record<string, { parseResponse: (d: unknown) => Record<string, unknown>[] }> })
    .PROVIDER_MODELS_CONFIG;
  const entry = config["zai-web-token"];
  const sampleResponse = {
    data: {
      data: [
        {
          id: "glm-5.2",
          name: "GLM 5.2",
          supportedThinkingEfforts: ["low", 123, null, "high", "", "max", undefined],
        },
      ],
    },
  };
  const parsed = entry.parseResponse(sampleResponse);
  assert.deepEqual(parsed[0].supportedThinkingEfforts, ["low", "high", "max"]);
});

test("parseResponse falls back to name when id is missing (matches zai-web pattern)", async () => {
  const mod = await import(
    "../../src/app/api/providers/[id]/models/discovery/providerModelsConfig.ts"
  );
  const config = (mod as { PROVIDER_MODELS_CONFIG?: Record<string, { parseResponse: (d: unknown) => Record<string, unknown>[] }> })
    .PROVIDER_MODELS_CONFIG;
  const entry = config["zai-web-token"];
  // The parseResponse uses `item.id || item.name` so a missing id falls back
  // to the name field. Only entries with neither id nor name are filtered.
  const sampleResponse = {
    data: {
      data: [
        { id: "glm-5.2", name: "GLM 5.2" },
        { name: "fallback-id-from-name" }, // id derived from name
        { id: "", name: "also-fallback" }, // empty id falls back to name
        { id: "glm-4.7", name: "GLM 4.7" },
      ],
    },
  };
  const parsed = entry.parseResponse(sampleResponse);
  assert.equal(parsed.length, 4);
  assert.equal(parsed[0].id, "glm-5.2");
  assert.equal(parsed[1].id, "fallback-id-from-name");
  assert.equal(parsed[2].id, "also-fallback");
  assert.equal(parsed[3].id, "glm-4.7");
});

test("parseResponse filters out entries with neither id nor name", async () => {
  const mod = await import(
    "../../src/app/api/providers/[id]/models/discovery/providerModelsConfig.ts"
  );
  const config = (mod as { PROVIDER_MODELS_CONFIG?: Record<string, { parseResponse: (d: unknown) => Record<string, unknown>[] }> })
    .PROVIDER_MODELS_CONFIG;
  const entry = config["zai-web-token"];
  const sampleResponse = {
    data: {
      data: [
        { id: "glm-5.2", name: "GLM 5.2" },
        { owned_by: "no-id-no-name" }, // should be filtered out
        { id: "", name: "" }, // should be filtered out
        { id: "glm-4.7", name: "GLM 4.7" },
      ],
    },
  };
  const parsed = entry.parseResponse(sampleResponse);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].id, "glm-5.2");
  assert.equal(parsed[1].id, "glm-4.7");
});

test("buildHeaders passes the raw JWT as Bearer (no extractZaiToken call)", async () => {
  const mod = await import(
    "../../src/app/api/providers/[id]/models/discovery/providerModelsConfig.ts"
  );
  const config = (mod as { PROVIDER_MODELS_CONFIG?: Record<string, { buildHeaders?: (t: string) => Record<string, string> }> })
    .PROVIDER_MODELS_CONFIG;
  const entry = config["zai-web-token"];
  assert.ok(entry.buildHeaders, "buildHeaders should be defined");
  const jwt = "eyJ.fake.jwt";
  const headers = entry.buildHeaders!(jwt);
  assert.equal(headers.Authorization, `Bearer ${jwt}`);
  assert.equal(headers["Content-Type"], "application/json");
});
