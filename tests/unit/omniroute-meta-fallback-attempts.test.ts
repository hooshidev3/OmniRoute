import test from "node:test";
import assert from "node:assert/strict";
import { OMNIROUTE_RESPONSE_HEADERS } from "../../src/shared/constants/headers.ts";
import { buildRouteChiResponseMetaHeaders } from "../../src/domain/omnirouteResponseMeta.ts";

test("headers constant exposes the fallback-attempts key", () => {
  assert.equal(
    OMNIROUTE_RESPONSE_HEADERS.fallbackAttempts,
    "X-RouteChi-Fallback-Attempts"
  );
});

test("buildRouteChiResponseMetaHeaders emits the fallback-attempts count when > 0", () => {
  const h = buildRouteChiResponseMetaHeaders({ model: "gpt", provider: "openai", fallbackAttempts: 2 });
  assert.equal(h["X-RouteChi-Fallback-Attempts"], "2");
});

test("buildRouteChiResponseMetaHeaders omits the header when 0 / absent", () => {
  const none = buildRouteChiResponseMetaHeaders({ model: "gpt" });
  assert.equal(none["X-RouteChi-Fallback-Attempts"], undefined);
  const zero = buildRouteChiResponseMetaHeaders({ model: "gpt", fallbackAttempts: 0 });
  assert.equal(zero["X-RouteChi-Fallback-Attempts"], undefined);
});
