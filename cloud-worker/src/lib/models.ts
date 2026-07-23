/**
 * Model resolver — derives the model list from the sync bundle.
 *
 * Models come from two sources:
 * 1. Provider `defaultModel` fields (explicitly set by the user)
 * 2. Model aliases (named model groupings)
 *
 * The worker doesn't implement full combo routing — it just lists
 * available models so clients can discover them via GET /v1/models.
 */

import type { SyncBundle } from "../types.ts";

interface ModelEntry {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

/**
 * Build an OpenAI-compatible /v1/models response from the bundle.
 */
export function buildModelsResponse(bundle: SyncBundle): {
  object: string;
  data: ModelEntry[];
} {
  const models = new Map<string, ModelEntry>();
  const now = Math.floor(Date.now() / 1000);

  // 1. Add provider default models
  for (const provider of bundle.providers) {
    if (provider.isActive === false) continue;
    const dm = provider.defaultModel;
    if (typeof dm === "string" && dm.trim() && !models.has(dm)) {
      models.set(dm, {
        id: dm,
        object: "model",
        created: now,
        owned_by: provider.provider || "omniroute",
      });
    }
  }

  // 2. Add model aliases
  if (bundle.modelAliases && typeof bundle.modelAliases === "object") {
    for (const alias of Object.keys(bundle.modelAliases)) {
      if (!models.has(alias)) {
        models.set(alias, {
          id: alias,
          object: "model",
          created: now,
          owned_by: "omniroute",
        });
      }
    }
  }

  // 3. Add combo names as "models" (so clients can route to them)
  for (const combo of bundle.combos) {
    if (combo.name && !models.has(combo.name)) {
      models.set(combo.name, {
        id: combo.name,
        object: "model",
        created: now,
        owned_by: "omniroute-combo",
      });
    }
  }

  return {
    object: "list",
    data: [...models.values()],
  };
}

/**
 * Resolve which provider to use for a given model.
 * Returns a single provider (the first match) or null if none available.
 *
 * Kept for backward compatibility — prefer resolveProvidersForModel()
 * which returns a fallback chain.
 */
export function resolveProviderForModel(
  bundle: SyncBundle,
  model: string
): SyncBundle["providers"][0] | null {
  const chain = resolveProvidersForModel(bundle, model);
  return chain.length > 0 ? chain[0] : null;
}

/**
 * Resolve an ordered list of providers that can serve the given model.
 * The first provider in the list is the primary; subsequent providers
 * are fallbacks (tried in order if the primary fails with 5xx or network
 * error).
 *
 * Ordering:
 *   1. Exact match on defaultModel (sorted by priority, then globalPriority)
 *   2. Provider prefix match (model "openai/gpt-4" → provider "openai")
 *   3. All other active providers (sorted by priority) as last-resort fallback
 */
export function resolveProvidersForModel(
  bundle: SyncBundle,
  model: string
): SyncBundle["providers"][0][] {
  const activeProviders = bundle.providers.filter((p) => p.isActive !== false);
  if (activeProviders.length === 0) return [];

  // Sort by priority (ascending — lower number = higher priority)
  const sortByPriority = (a: SyncBundle["providers"][0], b: SyncBundle["providers"][0]) => {
    const pa = a.priority ?? a.globalPriority ?? 9999;
    const pb = b.priority ?? b.globalPriority ?? 9999;
    return pa - pb;
  };

  // 1. Exact match on defaultModel
  const exactMatches = activeProviders.filter((p) => p.defaultModel === model).sort(sortByPriority);
  if (exactMatches.length > 0) {
    // Exact matches first, then other active providers as fallback
    const fallbacks = activeProviders.filter((p) => p.defaultModel !== model).sort(sortByPriority);
    return [...exactMatches, ...fallbacks];
  }

  // 2. Provider prefix match (e.g. model "openai/gpt-4" → provider "openai")
  const slashIdx = model.indexOf("/");
  if (slashIdx > 0) {
    const prefix = model.slice(0, slashIdx);
    const prefixMatches = activeProviders.filter((p) => p.provider === prefix).sort(sortByPriority);
    if (prefixMatches.length > 0) {
      const fallbacks = activeProviders.filter((p) => p.provider !== prefix).sort(sortByPriority);
      return [...prefixMatches, ...fallbacks];
    }
  }

  // 3. All active providers sorted by priority (let the upstream decide)
  return [...activeProviders].sort(sortByPriority);
}
