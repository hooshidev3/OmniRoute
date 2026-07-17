import test from "node:test";
import assert from "node:assert/strict";

import {
  attachRouteChiMetaHeaders,
  buildRouteChiResponseMetaHeaders,
  buildRouteChiSseMetadataComment,
  formatRouteChiCost,
  getRouteChiTokenCounts,
} from "../../src/domain/omnirouteResponseMeta.ts";
import { APP_CONFIG } from "../../src/shared/constants/appConfig.ts";
import { OMNIROUTE_RESPONSE_HEADERS } from "../../src/shared/constants/headers.ts";

test("getRouteChiTokenCounts normalizes common usage shapes", () => {
  assert.deepEqual(
    getRouteChiTokenCounts({
      prompt_tokens: 12,
      completion_tokens: 5,
    }),
    { input: 12, output: 5 }
  );
  assert.deepEqual(
    getRouteChiTokenCounts({
      input_tokens: "9",
      output_tokens: "4",
    }),
    { input: 9, output: 4 }
  );
});

test("buildRouteChiResponseMetaHeaders formats provider alias, tokens, latency, and cost", () => {
  const headers = buildRouteChiResponseMetaHeaders({
    provider: "claude",
    model: "claude-sonnet-4-6",
    cacheHit: true,
    latencyMs: 1234.6,
    usage: {
      prompt_tokens: 11,
      completion_tokens: 7,
    },
    costUsd: 0.00123456789,
  });

  assert.equal(headers["X-RouteChi-Provider"], "cc");
  assert.equal(headers["X-RouteChi-Model"], "claude-sonnet-4-6");
  assert.equal(headers["X-RouteChi-Cache-Hit"], "true");
  assert.equal(headers["X-RouteChi-Latency-Ms"], "1235");
  assert.equal(headers["X-RouteChi-Tokens-In"], "11");
  assert.equal(headers["X-RouteChi-Tokens-Out"], "7");
  assert.equal(headers["X-RouteChi-Response-Cost"], "0.0012345679");
});

test("buildRouteChiResponseMetaHeaders keeps ASCII model header values unchanged", () => {
  const headers = buildRouteChiResponseMetaHeaders({
    provider: "openai",
    model: "gpt-4o-mini",
  });

  assert.equal(headers[OMNIROUTE_RESPONSE_HEADERS.model], "gpt-4o-mini");
});

test("buildRouteChiResponseMetaHeaders percent-encodes non-ASCII model header values", () => {
  const model = "free-mix/[假流式]gemini-3.5-flash";
  const headers = buildRouteChiResponseMetaHeaders({
    provider: "openai",
    model,
  });

  assert.equal(headers[OMNIROUTE_RESPONSE_HEADERS.model], encodeURIComponent(model));
  assert.doesNotThrow(() => new Headers(headers));
});

test("buildRouteChiResponseMetaHeaders strips control characters from string header values", () => {
  const headers = buildRouteChiResponseMetaHeaders({
    provider: "openai",
    model: "free\r\nX-Injected: yes\u0000-model",
    requestId: "req-1\nreq-2\rreq-3\u0007",
  });

  assert.doesNotMatch(headers[OMNIROUTE_RESPONSE_HEADERS.model], /[\r\n\u0000-\u001f\u007f]/);
  assert.doesNotMatch(headers[OMNIROUTE_RESPONSE_HEADERS.requestId], /[\r\n\u0000-\u001f\u007f]/);
  assert.equal(headers[OMNIROUTE_RESPONSE_HEADERS.model], "freeX-Injected: yes-model");
  assert.equal(headers[OMNIROUTE_RESPONSE_HEADERS.requestId], "req-1req-2req-3");
  assert.doesNotThrow(() => new Headers(headers));
});

test("buildRouteChiResponseMetaHeaders always emits X-RouteChi-Version", () => {
  const headers = buildRouteChiResponseMetaHeaders({ provider: "openai", model: "gpt" });
  assert.equal(headers[OMNIROUTE_RESPONSE_HEADERS.version], APP_CONFIG.version);

  // Even with no provider/model at all, the version is still attached.
  const bare = buildRouteChiResponseMetaHeaders({});
  assert.equal(bare[OMNIROUTE_RESPONSE_HEADERS.version], APP_CONFIG.version);
});

test("buildRouteChiResponseMetaHeaders emits X-RouteChi-Request-Id only when provided", () => {
  const withId = buildRouteChiResponseMetaHeaders({ model: "gpt", requestId: "req-123" });
  assert.equal(withId[OMNIROUTE_RESPONSE_HEADERS.requestId], "req-123");

  const noId = buildRouteChiResponseMetaHeaders({ model: "gpt" });
  assert.equal(noId[OMNIROUTE_RESPONSE_HEADERS.requestId], undefined);

  const nullId = buildRouteChiResponseMetaHeaders({ model: "gpt", requestId: null });
  assert.equal(nullId[OMNIROUTE_RESPONSE_HEADERS.requestId], undefined);

  const blankId = buildRouteChiResponseMetaHeaders({ model: "gpt", requestId: "   " });
  assert.equal(blankId[OMNIROUTE_RESPONSE_HEADERS.requestId], undefined);
});

test("attachRouteChiMetaHeaders mutates a Headers instance in place, preserving existing entries", () => {
  const headers = new Headers({ "Content-Type": "application/json" });
  attachRouteChiMetaHeaders(headers, {
    provider: "openai",
    model: "gpt",
    requestId: "req-abc",
  });

  assert.equal(headers.get("Content-Type"), "application/json");
  assert.equal(headers.get(OMNIROUTE_RESPONSE_HEADERS.version), APP_CONFIG.version);
  assert.equal(headers.get(OMNIROUTE_RESPONSE_HEADERS.requestId), "req-abc");
  assert.equal(headers.get(OMNIROUTE_RESPONSE_HEADERS.model), "gpt");
});

test("attachRouteChiMetaHeaders mutates a plain record in place, preserving existing entries", () => {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  attachRouteChiMetaHeaders(headers, {
    provider: "openai",
    model: "gpt",
  });

  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers[OMNIROUTE_RESPONSE_HEADERS.version], APP_CONFIG.version);
  assert.equal(headers[OMNIROUTE_RESPONSE_HEADERS.model], "gpt");
  // No requestId provided → header omitted.
  assert.equal(headers[OMNIROUTE_RESPONSE_HEADERS.requestId], undefined);
});

test("buildRouteChiSseMetadataComment emits comment lines compatible with SSE", () => {
  const comment = buildRouteChiSseMetadataComment({
    provider: "openai",
    model: "gpt-4o-mini",
    usage: {
      prompt_tokens: 4,
      completion_tokens: 2,
    },
    latencyMs: 50,
    costUsd: formatRouteChiCost(0),
  });

  assert.match(comment, /^: x-omniroute-cache-hit=false/m);
  assert.match(comment, /^: x-omniroute-provider=openai/m);
  assert.match(comment, /^: x-omniroute-model=gpt-4o-mini/m);
  assert.match(comment, /^: x-omniroute-tokens-in=4/m);
  assert.match(comment, /^: x-omniroute-tokens-out=2/m);
  assert.match(comment, /^: x-omniroute-response-cost=0\.0000000000/m);
});

test("buildRouteChiResponseMetaHeaders emits X-RouteChi-Cost-Saved only when costSavedUsd is provided", () => {
  // Cache HIT: the incremental cost of serving the hit is 0, but the cache saved the
  // original (would-have-been) cost — surfaced via the Cost-Saved header for analytics.
  const hit = buildRouteChiResponseMetaHeaders({
    provider: "openai",
    model: "gpt-4o",
    cacheHit: true,
    costUsd: 0,
    costSavedUsd: 0.0125,
  });
  assert.equal(hit[OMNIROUTE_RESPONSE_HEADERS.responseCost], "0.0000000000");
  assert.equal(hit[OMNIROUTE_RESPONSE_HEADERS.costSaved], "0.0125000000");

  // A normal response (no costSavedUsd) omits the Cost-Saved header entirely.
  const miss = buildRouteChiResponseMetaHeaders({
    provider: "openai",
    model: "gpt-4o",
    costUsd: 0.0125,
  });
  assert.equal(miss[OMNIROUTE_RESPONSE_HEADERS.costSaved], undefined);

  // A free-model HIT still emits Cost-Saved (= 0) — it explicitly passed costSavedUsd.
  const freeHit = buildRouteChiResponseMetaHeaders({
    cacheHit: true,
    costUsd: 0,
    costSavedUsd: 0,
  });
  assert.equal(freeHit[OMNIROUTE_RESPONSE_HEADERS.costSaved], "0.0000000000");
});

test("attachRouteChiMetaHeaders forwards costSavedUsd onto a Headers bag", () => {
  const headers = new Headers({ "Content-Type": "application/json" });
  attachRouteChiMetaHeaders(headers, {
    provider: "openai",
    model: "gpt-4o",
    cacheHit: true,
    costUsd: 0,
    costSavedUsd: 0.0125,
  });
  assert.equal(headers.get(OMNIROUTE_RESPONSE_HEADERS.responseCost), "0.0000000000");
  assert.equal(headers.get(OMNIROUTE_RESPONSE_HEADERS.costSaved), "0.0125000000");
});
