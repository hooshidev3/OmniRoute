import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_OMNIROUTE_BASE_URL,
  resolveRouteChiBaseUrl,
} from "../../src/shared/utils/resolveRouteChiBaseUrl.ts";

test("resolveRouteChiBaseUrl prefers OMNIROUTE_BASE_URL", () => {
  assert.equal(
    resolveRouteChiBaseUrl({
      OMNIROUTE_BASE_URL: "https://internal.example.com/",
      BASE_URL: "https://base.example.com",
      NEXT_PUBLIC_BASE_URL: "https://public.example.com",
    }),
    "https://internal.example.com"
  );
});

test("resolveRouteChiBaseUrl falls back to BASE_URL", () => {
  assert.equal(
    resolveRouteChiBaseUrl({
      BASE_URL: "https://base.example.com/",
      NEXT_PUBLIC_BASE_URL: "https://public.example.com",
    }),
    "https://base.example.com"
  );
});

test("resolveRouteChiBaseUrl falls back to NEXT_PUBLIC_BASE_URL", () => {
  assert.equal(
    resolveRouteChiBaseUrl({
      NEXT_PUBLIC_BASE_URL: "https://public.example.com/",
    }),
    "https://public.example.com"
  );
});

test("resolveRouteChiBaseUrl ignores blank values", () => {
  assert.equal(
    resolveRouteChiBaseUrl({
      OMNIROUTE_BASE_URL: "   ",
      BASE_URL: "",
      NEXT_PUBLIC_BASE_URL: " https://public.example.com/ ",
    }),
    "https://public.example.com"
  );
});

test("resolveRouteChiBaseUrl uses the default localhost fallback", () => {
  assert.equal(resolveRouteChiBaseUrl({}), DEFAULT_OMNIROUTE_BASE_URL);
});
