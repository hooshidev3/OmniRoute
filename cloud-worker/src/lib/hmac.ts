/**
 * HMAC-SHA256 signing for Cloud Sync responses.
 *
 * The local OmniRoute instance verifies `X-Cloud-Sig` on every response
 * using `crypto.timingSafeEqual`. If the secret is not set on either side,
 * signing is skipped (backward-compat until v3.9 enforcement).
 *
 * Secret resolution order:
 *   1. env.CLOUD_SYNC_SECRET (set via wrangler secret put or Deploy Button)
 *   2. KV key "secret:cloud-sync" (set by the /setup endpoint)
 *   3. null (no signing — backward-compat mode)
 */

import type { Env } from "../types.ts";

/** KV key where the /setup endpoint stores the generated secret. */
const SECRET_KV_KEY = "secret:cloud-sync";

/**
 * Resolve the cloud sync secret from env or KV.
 * Called by signResponse() and verifyApiKey() paths.
 */
async function getCloudSyncSecret(env: Env): Promise<string | null> {
  // 1. Check env (set via wrangler secret put or Deploy Button)
  if (env.CLOUD_SYNC_SECRET) return env.CLOUD_SYNC_SECRET;

  // 2. Check KV (set by /setup endpoint)
  try {
    const kvSecret = await env.BUNDLES.get(SECRET_KV_KEY);
    if (kvSecret) return kvSecret;
  } catch {
    // KV read failed — fall through to null
  }

  // 3. No secret configured
  return null;
}

/**
 * Sign a response body with HMAC-SHA256.
 * Returns the hex digest, or null if no secret is configured.
 */
export async function signResponse(env: Env, body: string): Promise<string | null> {
  const secret = await getCloudSyncSecret(env);
  if (!secret) return null;
  return hmacSha256(secret, body);
}

/**
 * Verify a Bearer token against the sync bundle's API keys.
 * Returns true if the token matches an active API key.
 *
 * @deprecated Use findApiKey() from acl.ts instead — it returns the full
 * API key record which is needed for ACL checks (allowedModels, schedule, etc).
 * This function is kept for backward compatibility with verify.ts and models.ts
 * which don't need ACL checks.
 */
export function verifyApiKey(
  bearerToken: string | null,
  bundle: { apiKeys?: Array<{ key: string; isActive?: boolean }> } | null
): boolean {
  if (!bearerToken || !bundle?.apiKeys) return false;
  // Extract token from "Bearer xxx" header
  const token = bearerToken.startsWith("Bearer ")
    ? bearerToken.slice(7).trim()
    : bearerToken.trim();
  if (!token) return false;
  return bundle.apiKeys.some((k) => k.key === token && k.isActive !== false);
}

/**
 * Compute HMAC-SHA256 using Web Crypto API (available in Cloudflare Workers).
 */
async function hmacSha256(secret: string, message: string): Promise<string> {
  // Use Web Crypto API for HMAC-SHA256
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return bufferToHex(signature);
}

/**
 * Convert ArrayBuffer to hex string.
 */
function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}
