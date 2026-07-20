/**
 * Bundled Cloudflare Worker script for Cloud Sync.
 *
 * This is a single-file ES module that gets deployed to Cloudflare Workers
 * via the API. All routes, types, and helpers from cloud-worker/src/ are
 * inlined here because the Cloudflare API accepts a single JS file.
 *
 * Placeholders (filled by the deploy API route before upload):
 *   __KV_BINDING__   — KV namespace ID
 *   __CLOUD_SECRET__ — HMAC signing secret
 */

export function buildWorkerScript(kvNamespaceId: string, cloudSecret: string): string {
  return `// OmniRoute Cloud Worker — auto-deployed
// KV namespace: ${kvNamespaceId}
const CLOUD_SYNC_SECRET = ${JSON.stringify(cloudSecret)};

// ── Types ──
const KEY_PREFIX = "bundle:";
const TTL_SECONDS = 30 * 24 * 60 * 60;

// ── HMAC ──
async function hmacSha256(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  const bytes = new Uint8Array(sig);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}
function signResponse(body) {
  if (!CLOUD_SYNC_SECRET) return null;
  return hmacSha256(CLOUD_SYNC_SECRET, body);
}
function verifyApiKey(bearer, bundle) {
  if (!bearer || !bundle?.apiKeys) return false;
  const token = bearer.startsWith("Bearer ") ? bearer.slice(7).trim() : bearer.trim();
  if (!token) return false;
  return bundle.apiKeys.some(k => k.key === token && k.isActive !== false);
}

// ── Storage ──
async function storeBundle(env, machineId, bundle) {
  bundle.syncedAt = new Date().toISOString();
  await env.BUNDLES.put(KEY_PREFIX + machineId, JSON.stringify(bundle), { expirationTtl: TTL_SECONDS });
}
async function getBundle(env, machineId) {
  const raw = await env.BUNDLES.get(KEY_PREFIX + machineId);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
async function deleteBundle(env, machineId) {
  await env.BUNDLES.delete(KEY_PREFIX + machineId);
}

// ── Models ──
function buildModelsResponse(bundle) {
  const models = new Map();
  const now = Math.floor(Date.now() / 1000);
  for (const p of (bundle.providers || [])) {
    if (p.isActive === false) continue;
    if (p.defaultModel && !models.has(p.defaultModel)) {
      models.set(p.defaultModel, { id: p.defaultModel, object: "model", created: now, owned_by: p.provider || "omniroute" });
    }
  }
  if (bundle.modelAliases) {
    for (const alias of Object.keys(bundle.modelAliases)) {
      if (!models.has(alias)) models.set(alias, { id: alias, object: "model", created: now, owned_by: "omniroute" });
    }
  }
  for (const c of (bundle.combos || [])) {
    if (c.name && !models.has(c.name)) models.set(c.name, { id: c.name, object: "model", created: now, owned_by: "omniroute-combo" });
  }
  return { object: "list", data: [...models.values()] };
}
function resolveProviderForModel(bundle, model) {
  const active = (bundle.providers || []).filter(p => p.isActive !== false);
  if (active.length === 0) return null;
  const exact = active.find(p => p.defaultModel === model);
  if (exact) return exact;
  const slash = model.indexOf("/");
  if (slash > 0) {
    const prefix = model.slice(0, slash);
    const pm = active.find(p => p.provider === prefix);
    if (pm) return pm;
  }
  return active[0];
}

// ── Helpers ──
function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { "Content-Type": "application/json" } });
}
function getDefaultBaseUrl(provider) {
  const defaults = {
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

// ── Routes ──
async function handleSync(request, env, machineId) {
  if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return jsonError(400, "Invalid JSON body"); }
    const version = typeof body.version === "string" ? body.version : "";
    const providers = Array.isArray(body.providers) ? body.providers : [];
    const apiKeys = Array.isArray(body.apiKeys) ? body.apiKeys : [];
    const combos = Array.isArray(body.combos) ? body.combos : [];
    const settings = (body.settings && typeof body.settings === "object") ? body.settings : {};
    const modelAliases = (body.modelAliases && typeof body.modelAliases === "object") ? body.modelAliases : {};
    const providerNodes = Array.isArray(body.providerNodes) ? body.providerNodes : [];
    const existing = await getBundle(env, machineId);
    if (existing && existing.apiKeys && existing.apiKeys.length > 0) {
      const auth = request.headers.get("Authorization");
      const token = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : null;
      if (!token) return jsonError(401, "Authorization required: Bearer token missing");
      if (!existing.apiKeys.some(k => k.key === token && k.isActive !== false)) return jsonError(401, "Invalid API key");
    }
    const bundle = { version, providers, apiKeys, combos, settings, modelAliases, providerNodes };
    await storeBundle(env, machineId, bundle);
    const resp = { success: true, message: "Synced successfully", version, changes: { providers: providers.length, apiKeys: apiKeys.length, combos: combos.length }, data: { providers } };
    const rj = JSON.stringify(resp);
    const sig = await signResponse(rj);
    return new Response(rj, { status: 200, headers: { "Content-Type": "application/json", ...(sig ? { "X-Cloud-Sig": sig } : {}) } });
  }
  if (request.method === "DELETE") {
    const existing = await getBundle(env, machineId);
    if (existing && existing.apiKeys && existing.apiKeys.length > 0) {
      const auth = request.headers.get("Authorization");
      const token = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : null;
      if (!token) return jsonError(401, "Authorization required");
      if (!existing.apiKeys.some(k => k.key === token && k.isActive !== false)) return jsonError(401, "Invalid API key");
    }
    await deleteBundle(env, machineId);
    const rj = JSON.stringify({ success: true, message: "Deleted successfully" });
    const sig = await signResponse(rj);
    return new Response(rj, { status: 200, headers: { "Content-Type": "application/json", ...(sig ? { "X-Cloud-Sig": sig } : {}) } });
  }
  return jsonError(405, "Method not allowed");
}

async function handleVerify(request, env, machineId) {
  const bundle = await getBundle(env, machineId);
  if (!bundle) return jsonError(404, "Bundle not found");
  if (!verifyApiKey(request.headers.get("Authorization"), bundle)) return jsonError(401, "Invalid API key");
  const resp = { success: true, machineId, version: bundle.version, providerCount: bundle.providers.length, apiKeyCount: bundle.apiKeys.length, syncedAt: bundle.syncedAt };
  const rj = JSON.stringify(resp);
  const sig = await signResponse(rj);
  return new Response(rj, { status: 200, headers: { "Content-Type": "application/json", ...(sig ? { "X-Cloud-Sig": sig } : {}) } });
}

async function handleModels(request, env, machineId) {
  const bundle = await getBundle(env, machineId);
  if (!bundle) return jsonError(404, "Bundle not found");
  if (!verifyApiKey(request.headers.get("Authorization"), bundle)) return jsonError(401, "Invalid API key");
  const resp = buildModelsResponse(bundle);
  const rj = JSON.stringify(resp);
  const sig = await signResponse(rj);
  return new Response(rj, { status: 200, headers: { "Content-Type": "application/json", ...(sig ? { "X-Cloud-Sig": sig } : {}) } });
}

async function handleChat(request, env, machineId) {
  const bundle = await getBundle(env, machineId);
  if (!bundle) return jsonError(404, "Bundle not found");
  if (!verifyApiKey(request.headers.get("Authorization"), bundle)) return jsonError(401, "Invalid API key");
  let body;
  try { body = await request.json(); } catch { return jsonError(400, "Invalid JSON body"); }
  const model = typeof body.model === "string" ? body.model : "";
  if (!model) return jsonError(400, "Missing model field");
  const stream = body.stream === true;
  const provider = resolveProviderForModel(bundle, model);
  if (!provider) return jsonError(503, "No active provider available");
  const psd = provider.providerSpecificData || {};
  let baseUrl = (typeof psd.baseUrl === "string" && psd.baseUrl) || getDefaultBaseUrl(provider.provider);
  if (!baseUrl) return jsonError(502, "Cannot resolve provider base URL");
  baseUrl = baseUrl.replace(/\\/+$/, "");
  const chatPath = (typeof psd.chatPath === "string" && psd.chatPath) ? psd.chatPath : "/v1/chat/completions";
  const url = baseUrl + (chatPath.startsWith("/") ? chatPath : "/" + chatPath);
  const headers = { "Content-Type": "application/json" };
  if (provider.accessToken) headers["Authorization"] = "Bearer " + provider.accessToken;
  else if (provider.apiKey) headers["Authorization"] = "Bearer " + provider.apiKey;
  if (psd.customHeaders && typeof psd.customHeaders === "object") {
    for (const [k, v] of Object.entries(psd.customHeaders)) { if (typeof v === "string") headers[k] = v; }
  }
  try {
    const upstream = await fetch(url, { method: "POST", headers, body: JSON.stringify({ ...body, stream }) });
    if (!upstream.ok) {
      const et = await upstream.text();
      return jsonError(upstream.status, "Upstream error: " + et.slice(0, 500));
    }
    if (stream && upstream.body) {
      return new Response(upstream.body, { status: upstream.status, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
    }
    const rt = await upstream.text();
    const sig = await signResponse(rt);
    return new Response(rt, { status: 200, headers: { "Content-Type": "application/json", ...(sig ? { "X-Cloud-Sig": sig } : {}) } });
  } catch (err) {
    return jsonError(502, "Upstream fetch failed: " + (err.message || String(err)));
  }
}

// ── Main ──
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Cloud-Sig", "Access-Control-Max-Age": "86400" } });
    }
    const syncMatch = path.match(/^\\/sync\\/([a-f0-9]+)$/);
    if (syncMatch) return handleSync(request, env, syncMatch[1]);
    const verifyMatch = path.match(/^\\/([a-f0-9]+)\\/v1\\/verify$/);
    if (verifyMatch && request.method === "GET") return handleVerify(request, env, verifyMatch[1]);
    const modelsMatch = path.match(/^\\/([a-f0-9]+)\\/v1\\/models$/);
    if (modelsMatch && request.method === "GET") return handleModels(request, env, modelsMatch[1]);
    const chatMatch = path.match(/^\\/([a-f0-9]+)\\/v1\\/chat\\/completions$/);
    if (chatMatch && request.method === "POST") return handleChat(request, env, chatMatch[1]);
    if (path === "/" || path === "") {
      return new Response(JSON.stringify({ service: "omniroute-cloud", status: "ok", version: "1.0.0", timestamp: new Date().toISOString() }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: "Not found", path }), { status: 404, headers: { "Content-Type": "application/json" } });
  }
};`;
}
