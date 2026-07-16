/**
 * T-08 options-schema tests.
 *
 * Covers `parseRouteChiPluginOptions(opts)` — the strict Zod gate that
 * validates the second-arg `PluginOptions` bag from opencode.json before
 * any hook is wired. Anti-pattern checklist mirrored here:
 *
 *  - `null` / `undefined` must collapse to `{}` (defaults apply downstream).
 *  - Unknown keys must THROW (`.strict()` catches opencode.json typos).
 *  - Validation runs at parse time, not import time (module loads cleanly).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { parseRouteChiPluginOptions } from "../src/index.js";

test("parseRouteChiPluginOptions: undefined → {}", () => {
  assert.deepEqual(parseRouteChiPluginOptions(undefined), {});
});

test("parseRouteChiPluginOptions: null → {}", () => {
  assert.deepEqual(parseRouteChiPluginOptions(null), {});
});

test("parseRouteChiPluginOptions: empty object → {}", () => {
  assert.deepEqual(parseRouteChiPluginOptions({}), {});
});

test("parseRouteChiPluginOptions: valid providerId → returns it", () => {
  const r = parseRouteChiPluginOptions({ providerId: "omniroute-preprod" });
  assert.equal(r.providerId, "omniroute-preprod");
});

test("parseRouteChiPluginOptions: invalid providerId (special chars) → throws", () => {
  assert.throws(
    () => parseRouteChiPluginOptions({ providerId: "omniroute prod!" }),
    /providerId.*slug/i
  );
});

test("parseRouteChiPluginOptions: empty providerId → throws", () => {
  assert.throws(() => parseRouteChiPluginOptions({ providerId: "" }), /providerId/i);
});

test("parseRouteChiPluginOptions: valid modelCacheTtl → returns it", () => {
  const r = parseRouteChiPluginOptions({ modelCacheTtl: 60_000 });
  assert.equal(r.modelCacheTtl, 60_000);
});

test("parseRouteChiPluginOptions: negative modelCacheTtl → throws", () => {
  assert.throws(() => parseRouteChiPluginOptions({ modelCacheTtl: -1 }), /modelCacheTtl/i);
});

test("parseRouteChiPluginOptions: zero modelCacheTtl → throws (positive required)", () => {
  assert.throws(() => parseRouteChiPluginOptions({ modelCacheTtl: 0 }), /modelCacheTtl/i);
});

test("parseRouteChiPluginOptions: invalid baseURL (not a URL) → throws", () => {
  assert.throws(() => parseRouteChiPluginOptions({ baseURL: "not-a-url" }), /baseURL/i);
});

test("parseRouteChiPluginOptions: unknown key → throws (strict mode catches typos)", () => {
  assert.throws(
    () =>
      parseRouteChiPluginOptions({
        providerId: "omniroute",
        provider_id: "typo-here",
      }),
    /provider_id|unrecognized/i
  );
});

test("parseRouteChiPluginOptions: all four fields populated correctly → returns them", () => {
  const opts = {
    providerId: "omniroute-prod",
    displayName: "RouteChi Production",
    modelCacheTtl: 120_000,
    baseURL: "https://or.example.com/v1",
  };
  const r = parseRouteChiPluginOptions(opts);
  assert.deepEqual(r, opts);
});

test("parseRouteChiPluginOptions: error message lists every issue path", () => {
  // Two bad fields at once → error string should mention BOTH.
  try {
    parseRouteChiPluginOptions({
      providerId: "",
      baseURL: "garbage",
    });
    assert.fail("expected throw");
  } catch (err) {
    const msg = (err as Error).message;
    assert.match(msg, /providerId/);
    assert.match(msg, /baseURL/);
  }
});

test("parseRouteChiPluginOptions: module import alone does NOT throw", async () => {
  // Re-importing the entry must not trigger validation; validation only fires
  // on explicit parseRouteChiPluginOptions / RouteChiPlugin invocation.
  const mod = await import("../src/index.js");
  assert.equal(typeof mod.parseRouteChiPluginOptions, "function");
});
