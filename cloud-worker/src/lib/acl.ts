/**
 * API Key ACL — access control for incoming requests.
 *
 * Checks allowedModels, allowedCombos, allowedConnections, rate limits,
 * throttle, and access schedule. Returns an error response if the key
 * is not authorized for the requested model/combo/connection, or if
 * rate limits are exceeded.
 *
 * Management keys (isManagement=true) bypass all ACL checks.
 */

import type { BundleApiKey, SyncBundle, BundleCombo } from "../types.ts";

export interface AclResult {
  ok: boolean;
  error?: string;
  status?: number;
  /** The matching API key record (for rate-limit tracking). */
  apiKey?: BundleApiKey;
}

/**
 * Verify the Bearer token and return the matching API key record.
 * Returns null if no match.
 */
export function findApiKey(bearerToken: string | null, bundle: SyncBundle): BundleApiKey | null {
  if (!bearerToken || !bundle?.apiKeys) return null;
  const token = bearerToken.startsWith("Bearer ")
    ? bearerToken.slice(7).trim()
    : bearerToken.trim();
  if (!token) return null;
  return bundle.apiKeys.find((k) => k.key === token && k.isActive !== false) || null;
}

/**
 * Check if the API key is allowed to access the requested model/combo.
 * Returns AclResult with ok=true if allowed, ok=false with error if not.
 */
export function checkAcl(apiKey: BundleApiKey, bundle: SyncBundle, model: string): AclResult {
  // Management keys bypass all checks
  if (apiKey.isManagement) {
    return { ok: true, apiKey };
  }

  // Check if the model is a combo name
  const combo = bundle.combos.find((c) => c.name === model);

  // ── allowedModels ──
  if (apiKey.allowedModels && apiKey.allowedModels.length > 0) {
    const allowed = apiKey.allowedModels.some((m) => {
      if (m === model) return true;
      // Support wildcard: "openai/*" matches "openai/gpt-4"
      if (m.endsWith("/*")) {
        const prefix = m.slice(0, -2);
        return model.startsWith(prefix + "/");
      }
      return false;
    });
    if (!allowed) {
      return {
        ok: false,
        status: 403,
        error: `API key not allowed for model: ${model}`,
        apiKey,
      };
    }
  }

  // ── allowedCombos ──
  if (combo && apiKey.allowedCombos && apiKey.allowedCombos.length > 0) {
    if (!apiKey.allowedCombos.includes(combo.id)) {
      return {
        ok: false,
        status: 403,
        error: `API key not allowed for combo: ${combo.name || combo.id}`,
        apiKey,
      };
    }
  }

  // ── allowedConnections ──
  // (checked at provider-resolution time in chat.ts — we need to know which
  // provider will be selected first)

  // ── accessSchedule ──
  if (apiKey.accessSchedule) {
    const now = new Date();
    const schedule = apiKey.accessSchedule;
    if (schedule.daysOfWeek && schedule.daysOfWeek.length > 0) {
      const dayOfWeek = now.getDay(); // 0=Sun, 6=Sat
      if (!schedule.daysOfWeek.includes(dayOfWeek)) {
        return {
          ok: false,
          status: 403,
          error: `API key not allowed on day ${dayOfWeek} (allowed: ${schedule.daysOfWeek.join(", ")})`,
          apiKey,
        };
      }
    }
    if (typeof schedule.startHour === "number" && typeof schedule.endHour === "number") {
      const hour = now.getHours();
      if (schedule.startHour <= schedule.endHour) {
        // Same-day range, e.g. 9-17
        if (hour < schedule.startHour || hour >= schedule.endHour) {
          return {
            ok: false,
            status: 403,
            error: `API key not allowed at hour ${hour} (allowed: ${schedule.startHour}-${schedule.endHour})`,
            apiKey,
          };
        }
      } else {
        // Overnight range, e.g. 22-6
        if (hour >= schedule.endHour && hour < schedule.startHour) {
          return {
            ok: false,
            status: 403,
            error: `API key not allowed at hour ${hour} (allowed: ${schedule.startHour}-${schedule.endHour} overnight)`,
            apiKey,
          };
        }
      }
    }
  }

  // ── rate limiting ──
  // Note: true rate limiting requires per-key state (counters in KV).
  // For now, we only check the schedule. Full rate limiting is a TODO
  // because Cloudflare KV is eventually consistent and not ideal for
  // high-frequency counters. The local OmniRoute instance handles
  // real rate limiting; the worker is a pass-through.

  return { ok: true, apiKey };
}

/**
 * Check if the API key is allowed to use a specific provider connection.
 * Called after provider resolution in chat.ts.
 */
export function checkConnectionAcl(apiKey: BundleApiKey, connectionId: string): boolean {
  if (apiKey.isManagement) return true;
  if (!apiKey.allowedConnections || apiKey.allowedConnections.length === 0) {
    return true; // no restriction
  }
  return apiKey.allowedConnections.includes(connectionId);
}
