/**
 * POST /:machineId/v1/chat/completions — OpenAI-compatible chat proxy.
 *
 * Reads the synced bundle from KV, resolves which provider to use based
 * on the requested model, applies reasoning routing rules + API key ACL,
 * forwards the request to the upstream provider with the stored credentials,
 * and streams the response back.
 *
 * Features:
 *   - API key ACL (allowedModels/Combos/Connections + schedule)
 *   - Reasoning routing rules (effort mapping, model redirect)
 *   - Provider fallback (try next provider on failure)
 *   - Combo routing (resolve combo name → first model in combo)
 *   - Streaming (SSE) and non-streaming responses
 *   - HMAC-SHA256 response signing (non-streaming only)
 */

import type { Env, SyncBundle, BundleProvider, BundleApiKey, BundleCombo } from "../types.ts";
import { getBundle } from "../lib/storage.ts";
import { signResponse } from "../lib/hmac.ts";
import { findApiKey, checkAcl, checkConnectionAcl } from "../lib/acl.ts";
import { matchReasoningRule, applyReasoningRule } from "../lib/reasoning.ts";
import { resolveProvidersForModel } from "../lib/models.ts";

export async function handleChat(request: Request, env: Env, machineId: string): Promise<Response> {
  const bundle = await getBundle(env, machineId);
  if (!bundle) {
    return jsonError(404, "Bundle not found — sync first");
  }

  // ── Verify Bearer token + find matching API key ──
  const authHeader = request.headers.get("Authorization");
  const apiKey = findApiKey(authHeader, bundle);
  if (!apiKey) {
    return jsonError(401, "Invalid API key");
  }

  // ── Parse request body ──
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "Invalid JSON body");
  }

  const model = typeof body.model === "string" ? body.model : "";
  if (!model) {
    return jsonError(400, "Missing 'model' field");
  }

  // ── API key ACL check ──
  const aclResult = checkAcl(apiKey, bundle, model);
  if (!aclResult.ok) {
    return jsonError(aclResult.status || 403, aclResult.error || "Access denied");
  }

  // ── Check if model is a combo name ──
  const combo = bundle.combos.find((c) => c.name === model) || null;

  // ── Reasoning routing ──
  const sourceEffort =
    typeof body.reasoning_effort === "string" ? body.reasoning_effort : undefined;
  const tagsHeader = request.headers.get("x-omniroute-tags");
  const requestTags = tagsHeader
    ? tagsHeader
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : undefined;

  const reasoningCtx = {
    apiKey,
    combo,
    model,
    sourceEffort,
    requestTags,
  };

  const matchedRule = matchReasoningRule(bundle, reasoningCtx);
  const { body: routedBody, result: reasoningResult } = applyReasoningRule(body, matchedRule);
  body = routedBody;

  // If reasoning rule redirected to a combo, resolve the combo's first model
  let effectiveModel = model;
  if (reasoningResult.targetKind === "combo" && reasoningResult.targetComboId) {
    const targetCombo = bundle.combos.find((c) => c.id === reasoningResult.targetComboId);
    if (targetCombo) {
      // Use the first model in the combo's models array
      const comboModels = Array.isArray(targetCombo.models) ? targetCombo.models : [];
      if (comboModels.length > 0) {
        const firstModel = comboModels[0] as Record<string, unknown>;
        if (typeof firstModel === "string") {
          effectiveModel = firstModel;
          body = { ...body, model: effectiveModel };
        } else if (firstModel && typeof firstModel.model === "string") {
          effectiveModel = firstModel.model;
          body = { ...body, model: effectiveModel };
        }
      }
    }
  } else if (reasoningResult.targetModel) {
    effectiveModel = reasoningResult.targetModel;
  }

  const stream = body.stream === true;

  // ── Resolve providers (with fallback chain) ──
  const providers = resolveProvidersForModel(bundle, effectiveModel);
  if (providers.length === 0) {
    return jsonError(503, "No active provider available");
  }

  // ── Filter providers by allowedConnections ACL ──
  const allowedProviders = providers.filter((p) => checkConnectionAcl(apiKey, p.id));
  if (allowedProviders.length === 0) {
    return jsonError(403, "API key not allowed for any available provider connection");
  }

  // ── Try each provider in order (fallback) ──
  let lastError: { status: number; message: string } | null = null;
  for (let i = 0; i < allowedProviders.length; i++) {
    const provider = allowedProviders[i];
    const upstream = buildUpstreamRequest(provider, body, stream);
    if (!upstream) {
      lastError = {
        status: 502,
        message: `Cannot build upstream request for provider: ${provider.provider}`,
      };
      continue;
    }

    try {
      const upstreamResponse = await fetch(upstream.url, {
        method: "POST",
        headers: upstream.headers,
        body: JSON.stringify(upstream.body),
      });

      if (!upstreamResponse.ok) {
        const errorText = await upstreamResponse.text();
        lastError = {
          status: upstreamResponse.status,
          message: `Upstream error (${provider.provider}): ${errorText.slice(0, 300)}`,
        };
        // If this is a 4xx error (client error), don't try next provider
        // — the request itself is bad, retrying won't help.
        if (upstreamResponse.status >= 400 && upstreamResponse.status < 500) {
          return jsonError(upstreamResponse.status, lastError.message);
        }
        // 5xx → try next provider
        continue;
      }

      // ── Success — stream or sign+return ──
      if (stream && upstreamResponse.body) {
        return new Response(upstreamResponse.body, {
          status: upstreamResponse.status,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      const responseText = await upstreamResponse.text();
      const sig = await signResponse(env, responseText);

      return new Response(responseText, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ...(sig ? { "X-Cloud-Sig": sig } : {}),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastError = {
        status: 502,
        message: `Upstream fetch failed (${provider.provider}): ${message}`,
      };
      // Network error → try next provider
      continue;
    }
  }

  // All providers failed
  return jsonError(lastError?.status || 502, lastError?.message || "All providers failed");
}

/**
 * Build the upstream request URL, headers, and body for a given provider.
 */
function buildUpstreamRequest(
  provider: BundleProvider,
  body: Record<string, unknown>,
  stream: boolean
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null {
  const psd = provider.providerSpecificData || {};
  const baseUrl =
    (typeof psd.baseUrl === "string" && psd.baseUrl) ||
    (typeof psd.chatPath === "string" && psd.chatPath) ||
    getDefaultBaseUrl(provider.provider);
  if (!baseUrl) return null;

  // Normalize URL
  let url = baseUrl.replace(/\/+$/, "");
  const chatPath =
    typeof psd.chatPath === "string" && psd.chatPath ? psd.chatPath : "/v1/chat/completions";
  if (!url.endsWith(chatPath)) {
    url += chatPath.startsWith("/") ? chatPath : `/${chatPath}`;
  }

  // Build headers
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // Auth
  const apiKey = provider.apiKey;
  const accessToken = provider.accessToken;
  if (accessToken) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  } else if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  // Provider-specific headers
  if (typeof psd.customHeaders === "object" && psd.customHeaders) {
    for (const [k, v] of Object.entries(psd.customHeaders)) {
      if (typeof v === "string") headers[k] = v;
    }
  }

  // Build body — ensure stream matches what the client requested
  const upstreamBody = { ...body, stream };

  return { url, headers, body: upstreamBody };
}

/**
 * Get default base URL for well-known providers.
 */
function getDefaultBaseUrl(provider: string): string | null {
  const defaults: Record<string, string> = {
    openai: "https://api.openai.com/v1",
    anthropic: "https://api.anthropic.com/v1",
    gemini: "https://generativelanguage.googleapis.com/v1beta",
    groq: "https://api.groq.com/openai/v1",
    mistral: "https://api.mistral.ai/v1",
    together: "https://api.together.xyz/v1",
    deepseek: "https://api.deepseek.com/v1",
    zai: "https://api.z.ai/api/v1",
    "kilo-free": "https://api.kilo.ai/api/openrouter",
  };
  return defaults[provider] || null;
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
