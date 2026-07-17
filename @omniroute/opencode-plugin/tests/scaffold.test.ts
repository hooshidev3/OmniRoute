import test from "node:test";
import assert from "node:assert/strict";
import {
  RouteChiPlugin,
  OMNIROUTE_PROVIDER_KEY,
  DEFAULT_MODEL_CACHE_TTL_MS,
  resolveRouteChiPluginOptions,
} from "../src/index.js";

test("scaffold: exports public surface", () => {
  assert.equal(
    typeof RouteChiPlugin,
    "function",
    "RouteChiPlugin must be a function (Plugin factory)"
  );
  assert.equal(OMNIROUTE_PROVIDER_KEY, "omniroute");
  assert.equal(DEFAULT_MODEL_CACHE_TTL_MS, 300_000);
});

test("scaffold: default export is v1 plugin shape { id, server: RouteChiPlugin }", async () => {
  const mod = await import("../src/index.js");
  assert.equal(typeof mod.default, "object");
  assert.equal(mod.default.id, "@omniroute/opencode-plugin");
  assert.equal(mod.default.server, mod.RouteChiPlugin);
});

test("resolveRouteChiPluginOptions: defaults", () => {
  const r = resolveRouteChiPluginOptions();
  assert.equal(r.providerId, "opencode-omniroute");
  assert.equal(r.displayName, "RouteChi");
  assert.equal(r.modelCacheTtl, 300_000);
  assert.equal(r.baseURL, undefined);
});

test("resolveRouteChiPluginOptions: custom providerId derives displayName", () => {
  const r = resolveRouteChiPluginOptions({ providerId: "omniroute-preprod" });
  assert.equal(r.providerId, "opencode-omniroute-preprod");
  assert.equal(r.displayName, "RouteChi (opencode-omniroute-preprod)");
});

test("resolveRouteChiPluginOptions: explicit displayName wins", () => {
  const r = resolveRouteChiPluginOptions({
    providerId: "omniroute-x",
    displayName: "Custom Label",
  });
  assert.equal(r.displayName, "Custom Label");
});

test("resolveRouteChiPluginOptions: invalid TTL falls back to default", () => {
  assert.equal(resolveRouteChiPluginOptions({ modelCacheTtl: 0 }).modelCacheTtl, 300_000);
  assert.equal(resolveRouteChiPluginOptions({ modelCacheTtl: -1 }).modelCacheTtl, 300_000);
});

test("resolveRouteChiPluginOptions: positive TTL respected", () => {
  assert.equal(resolveRouteChiPluginOptions({ modelCacheTtl: 60_000 }).modelCacheTtl, 60_000);
});

test("RouteChiPlugin: returns an empty hooks object (scaffold)", async () => {
  const fakeCtx = {} as Parameters<typeof RouteChiPlugin>[0];
  const hooks = await RouteChiPlugin(fakeCtx);
  assert.equal(typeof hooks, "object");
  assert.notEqual(hooks, null);
});

test("scaffold: built ESM default export resolves with the v1 plugin shape", async () => {
  // The plugin is ESM-only now — the CJS bundle was dropped to fix the OpenCode
  // loader (#3883), so there is no more ../dist/index.cjs. Validate that the built
  // distributable's default export still carries the OpenCode v1 { id, server } shape.
  const mod = await import("../dist/index.js");
  assert.strictEqual(typeof mod.default, "object");
  assert.strictEqual(mod.default.id, "@omniroute/opencode-plugin");
  assert.strictEqual(typeof mod.default.server, "function");
});
