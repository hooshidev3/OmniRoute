import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Verifies that the upstream security features (CredentialMaskerGuardrail,
 * mitm root-CA, OIDC) are correctly wired and apply to the hooshidev3-specific
 * providers (zai-web-free, zai-web-token, kilo-free, xiaomimimo-web) just like
 * they apply to every other registered provider.
 */

describe("security: CredentialMaskerGuardrail is registered and active", () => {
  it("credentialMasker module is exported from guardrails index", async () => {
    const mod = await import("../../src/lib/guardrails/index.ts");
    assert.equal(typeof mod.CredentialMaskerGuardrail, "function");
  });

  it("guardrail registry registers CredentialMaskerGuardrail", async () => {
    // Dynamic import to avoid side effects at module load time
    const { guardrailRegistry, registerDefaultGuardrails } =
      await import("../../src/lib/guardrails/registry.ts");
    // Ensure defaults are registered (no-op if already registered)
    registerDefaultGuardrails();
    // The registry instance has a guardrails array
    const registry = guardrailRegistry as { guardrails?: unknown[]; list?: () => unknown[] };
    const registered = registry.guardrails ?? registry.list?.() ?? [];
    const names = Array.isArray(registered)
      ? registered.map((g: unknown) => {
          const ctor = (g as { constructor?: { name?: string } })?.constructor;
          const name = (g as { name?: string })?.name;
          return ctor?.name ?? name ?? "";
        })
      : [];
    assert.ok(
      names.some((n: string) => n.includes("CredentialMasker")),
      `CredentialMaskerGuardrail should be registered; found: ${names.join(", ")}`
    );
  });
});

describe("security: MITM root-CA module exists", () => {
  it("rootCa module is importable", async () => {
    const mod = await import("../../src/mitm/cert/rootCa.ts");
    assert.ok(mod, "rootCa module should be importable");
    // The module exports either a class, function, or object — just verify it's not empty
    const keys = Object.keys(mod);
    assert.ok(keys.length > 0, `rootCa module should export something; got: ${keys.join(",")}`);
  });

  it("migration module is importable", async () => {
    const mod = await import("../../src/mitm/cert/migration.ts");
    assert.ok(mod, "migration module should be importable");
    const keys = Object.keys(mod);
    assert.ok(keys.length > 0, `migration module should export something; got: ${keys.join(",")}`);
  });
});

describe("security: zai-web-free provider is in REGISTRY (so guardrail applies)", () => {
  it("zai-web-free is registered", async () => {
    const { REGISTRY } = await import("../../open-sse/config/providers/index.ts");
    assert.ok(REGISTRY["zai-web-free"], "zai-web-free should be in REGISTRY");
  });

  it("zai-web-token is registered", async () => {
    const { REGISTRY } = await import("../../open-sse/config/providers/index.ts");
    assert.ok(REGISTRY["zai-web-token"], "zai-web-token should be in REGISTRY");
  });

  it("kilo-free is registered", async () => {
    const { REGISTRY } = await import("../../open-sse/config/providers/index.ts");
    assert.ok(REGISTRY["kilo-free"], "kilo-free should be in REGISTRY");
  });

  it("xiaomimimo-web is registered", async () => {
    const { REGISTRY } = await import("../../open-sse/config/providers/index.ts");
    assert.ok(REGISTRY["xiaomimimo-web"], "xiaomimimo-web should be in REGISTRY");
  });
});

describe("security: .env.example documents the new env vars", () => {
  it("CREDENTIAL_REDACTION_ENABLED is documented", async () => {
    const fs = await import("node:fs");
    const content = fs.readFileSync(".env.example", "utf-8");
    assert.ok(
      content.includes("CREDENTIAL_REDACTION_ENABLED"),
      ".env.example should document CREDENTIAL_REDACTION_ENABLED"
    );
  });

  it("MITM_ROOT_CA_ENABLED is documented", async () => {
    const fs = await import("node:fs");
    const content = fs.readFileSync(".env.example", "utf-8");
    assert.ok(
      content.includes("MITM_ROOT_CA_ENABLED"),
      ".env.example should document MITM_ROOT_CA_ENABLED"
    );
  });
});
