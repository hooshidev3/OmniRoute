/**
 * Think Output Mode — Controls how <think>/reasoning content is rendered.
 *
 * Resolution priority:
 *   1. Per-request: x-omniroute-think-mode header
 *   2. Per-request: body.think_mode field
 *   3. Per-connection: providerSpecificData.requestDefaults.thinkMode
 *   4. Global: settings.thinkOutputMode
 *   5. Default: "separate"
 *
 * @module services/thinkOutputMode
 */

import type { ThinkMode } from "../utils/thinkModeProcessor.ts";
import { normalizeThinkMode } from "../utils/thinkModeProcessor.ts";

export type { ThinkMode };

export const DEFAULT_THINK_OUTPUT_MODE: ThinkMode = "separate";

const GLOBAL_KEY = "__omniroute_thinkOutputMode_config__";
const _store = globalThis as unknown as Record<string, { mode: ThinkMode } | undefined>;

function getConfig(): { mode: ThinkMode } {
  if (!_store[GLOBAL_KEY]) _store[GLOBAL_KEY] = { mode: DEFAULT_THINK_OUTPUT_MODE };
  return _store[GLOBAL_KEY]!;
}

export function setThinkOutputMode(mode: ThinkMode): void {
  _store[GLOBAL_KEY] = { mode: normalizeThinkMode(mode) };
}

export function getThinkOutputMode(): ThinkMode {
  return getConfig().mode;
}

export function hydrateThinkOutputMode(settings: unknown): boolean {
  const record = settings as Record<string, unknown> | null;
  if (!record || typeof record !== "object") return false;
  const value = record.thinkOutputMode;
  if (
    typeof value === "string" &&
    (value === "passthrough" || value === "strip" || value === "separate")
  ) {
    setThinkOutputMode(value);
    return true;
  }
  const nested = record.settings as Record<string, unknown> | undefined;
  if (nested && typeof nested.thinkOutputMode === "string") {
    setThinkOutputMode(normalizeThinkMode(nested.thinkOutputMode));
    return true;
  }
  return false;
}

function getHeaderValue(
  headers: Record<string, unknown> | Headers | null | undefined,
  name: string
): string | null {
  if (!headers) return null;
  if (typeof (headers as Headers).get === "function") {
    const v = (headers as Headers).get(name);
    return v && v.trim() ? v.trim() : null;
  }
  if (typeof headers === "object") {
    const lowered = name.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === lowered && typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return null;
}

export interface ResolveThinkModeOptions {
  headers?: Headers | Record<string, unknown> | null;
  body?: Record<string, unknown> | null;
  providerSpecificData?: Record<string, unknown> | null;
}

export function resolveThinkMode(options: ResolveThinkModeOptions): ThinkMode {
  const { headers, body, providerSpecificData } = options;

  // 1. Per-request header
  if (headers) {
    const hv = getHeaderValue(headers, "x-omniroute-think-mode");
    if (hv && (hv === "passthrough" || hv === "strip" || hv === "separate")) return hv;
  }

  // 2. Per-request body field
  if (body && typeof body === "object") {
    const bv = body.think_mode || body.thinkMode;
    if (typeof bv === "string" && bv.trim()) return normalizeThinkMode(bv);
  }

  // 3. Per-connection
  if (providerSpecificData && typeof providerSpecificData === "object") {
    const rd = providerSpecificData.requestDefaults;
    if (rd && typeof rd === "object") {
      const rdm = (rd as Record<string, unknown>).thinkMode;
      if (typeof rdm === "string" && rdm.trim()) return normalizeThinkMode(rdm);
    }
  }

  // 4. Global
  return getThinkOutputMode();
}

export function __resetThinkOutputModeForTest(): void {
  _store[GLOBAL_KEY] = { mode: DEFAULT_THINK_OUTPUT_MODE };
}
