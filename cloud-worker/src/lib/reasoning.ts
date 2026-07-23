/**
 * Reasoning routing — applies reasoning rules to the request body before
 * forwarding to the upstream provider.
 *
 * Rules are matched by scope (global/apiKey/combo/connection), model pattern,
 * source effort, and request tags. The first matching rule (by priority)
 * determines the action: map effort, strip effort, or passthrough.
 *
 * Ported from src/lib/sync/bundle.ts (reasoningRoutingRules field) and
 * src/app/api/v1/chat/completions/route.ts (rule application logic).
 */

import type { BundleReasoningRule, BundleApiKey, BundleCombo, SyncBundle } from "../types.ts";

export interface ReasoningContext {
  /** The API key making the request (for apiKey-scoped rules). */
  apiKey?: BundleApiKey;
  /** The combo being used (for combo-scoped rules). Null if not a combo. */
  combo?: BundleCombo | null;
  /** The connection ID being used (for connection-scoped rules). */
  connectionId?: string;
  /** The model being requested. */
  model: string;
  /** The reasoning_effort from the request body (if any). */
  sourceEffort?: string;
  /** Request tags from x-omniroute-tags header (if any). */
  requestTags?: string[];
}

export interface ReasoningResult {
  /** The new reasoning_effort to set (or undefined to leave unchanged). */
  targetEffort?: string;
  /** Whether to strip reasoning_effort entirely. */
  stripEffort: boolean;
  /** The rule that matched (for logging). */
  matchedRule?: BundleReasoningRule;
  /** If targetKind is "model" or "combo", the model/combo to redirect to. */
  targetModel?: string;
  targetComboId?: string;
  targetKind?: string;
}

/**
 * Find the first matching reasoning rule for the given context.
 * Rules are sorted by priority (ascending — lower number = higher priority).
 * Disabled rules (enabled=false) are skipped.
 */
export function matchReasoningRule(
  bundle: SyncBundle,
  ctx: ReasoningContext
): BundleReasoningRule | null {
  const rules = bundle.reasoningRoutingRules;
  if (!rules || rules.length === 0) return null;

  // Sort by priority (ascending). Rules without priority go last.
  const sorted = [...rules]
    .filter((r) => r.enabled !== false)
    .sort((a, b) => (a.priority ?? 9999) - (b.priority ?? 9999));

  for (const rule of sorted) {
    if (matchesRule(rule, ctx)) {
      return rule;
    }
  }
  return null;
}

/**
 * Check if a single rule matches the context.
 */
function matchesRule(rule: BundleReasoningRule, ctx: ReasoningContext): boolean {
  // ── Scope check ──
  if (rule.scope && rule.scope !== "global") {
    if (rule.scope === "apiKey") {
      if (!ctx.apiKey || rule.apiKeyId !== ctx.apiKey.id) return false;
    } else if (rule.scope === "combo") {
      if (!ctx.combo || rule.comboId !== ctx.combo.id) return false;
    } else if (rule.scope === "connection") {
      if (!ctx.connectionId || rule.connectionId !== ctx.connectionId) return false;
    }
  }

  // ── Model pattern check ──
  if (rule.modelPattern) {
    try {
      // Convert glob pattern to regex: "*" → ".*", "?" → "."
      const regexStr = rule.modelPattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
      const regex = new RegExp(`^${regexStr}$`, "i");
      if (!regex.test(ctx.model)) return false;
    } catch {
      // Invalid pattern — skip this rule
      return false;
    }
  }

  // ── Source effort check ──
  if (rule.sourceEffort && rule.sourceEffort !== "any") {
    if (ctx.sourceEffort !== rule.sourceEffort) return false;
  }

  // ── Request tags check ──
  if (rule.requestTags && rule.requestTags.length > 0) {
    const reqTags = ctx.requestTags || [];
    if (reqTags.length === 0) return false;
    const mode = rule.tagMatchMode || "any";
    if (mode === "any") {
      if (!rule.requestTags.some((t) => reqTags.includes(t))) return false;
    } else if (mode === "all") {
      if (!rule.requestTags.every((t) => reqTags.includes(t))) return false;
    } else if (mode === "none") {
      if (rule.requestTags.some((t) => reqTags.includes(t))) return false;
    }
  }

  return true;
}

/**
 * Apply the matched rule to the request body.
 * Returns the modified body and the match result.
 */
export function applyReasoningRule(
  body: Record<string, unknown>,
  rule: BundleReasoningRule | null
): { body: Record<string, unknown>; result: ReasoningResult } {
  const result: ReasoningResult = {
    stripEffort: false,
  };

  if (!rule) {
    return { body, result };
  }

  result.matchedRule = rule;

  // ── Effort mode ──
  if (rule.effortMode === "strip") {
    // Strip reasoning_effort from the body
    const { reasoning_effort: _re, ...rest } = body;
    body = rest;
    result.stripEffort = true;
  } else if (rule.effortMode === "map" && rule.targetEffort) {
    // Map to the target effort
    body = { ...body, reasoning_effort: rule.targetEffort };
    result.targetEffort = rule.targetEffort;
  }
  // effortMode === "passthrough" → no change

  // ── Target redirect ──
  if (rule.targetKind === "model" && rule.targetModel) {
    body = { ...body, model: rule.targetModel };
    result.targetModel = rule.targetModel;
    result.targetKind = "model";
  } else if (rule.targetKind === "combo" && rule.targetComboId) {
    // Combo redirect is handled by the caller (chat.ts) because it needs
    // to look up the combo name from the bundle.
    result.targetComboId = rule.targetComboId;
    result.targetKind = "combo";
  }

  return { body, result };
}
