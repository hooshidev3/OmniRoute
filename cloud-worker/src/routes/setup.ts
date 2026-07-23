/**
 * GET /setup — One-time secret exchange endpoint.
 *
 * Called by the local OmniRoute instance after deploying the Worker via
 * the Cloudflare "Deploy to Workers" button. This endpoint:
 *   1. Checks if CLOUD_SYNC_SECRET is already set (via env).
 *      - If yes → returns 409 "already configured" (idempotent — safe to retry).
 *   2. Generates a random 32-byte hex secret.
 *   3. Stores it in KV under "secret:cloud-sync" so it persists across
 *      Worker invocations (KV is the only persistent storage available).
 *   4. Also sets it as the env.CLOUD_SYNC_SECRET for this invocation so
 *      subsequent signResponse() calls use it immediately.
 *   5. Returns the secret in the response body (once — never again).
 *
 * Security:
 *   - This endpoint can only be called ONCE. After the secret is stored
 *     in KV, subsequent calls return 409 without revealing the secret.
 *   - The response is NOT signed (the secret is being established, so
 *     there's no shared secret to sign with yet).
 *   - The caller (OmniRoute local) must store the returned secret in its
 *     DB so it can verify future HMAC signatures.
 *   - The KV key "secret:cloud-sync" has no TTL — it persists forever.
 *   - If the Worker is re-deployed (e.g. via git push), the KV value
 *     survives because KV is separate from the Worker code.
 *
 * Note: We use KV instead of `wrangler secret put` because the /setup
 * endpoint runs in the Worker runtime, which cannot invoke the Cloudflare
 * API to set Worker secrets. KV is the only writable persistent storage
 * available to the Worker at runtime. The signResponse() function in
 * hmac.ts checks KV for the secret if env.CLOUD_SYNC_SECRET is empty.
 */

import type { Env } from "../types.ts";

const SECRET_KV_KEY = "secret:cloud-sync";

export async function handleSetup(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    return jsonError(405, "Method not allowed — use GET");
  }

  // ── Check if already configured ──
  // First check env (set via wrangler secret put or Deploy Button vars)
  if (env.CLOUD_SYNC_SECRET) {
    return jsonError(
      409,
      "Worker is already configured — secret exists in env. Use the existing secret or delete it via dashboard to re-setup."
    );
  }

  // Then check KV (set by a previous /setup call)
  const existingSecret = await env.BUNDLES.get(SECRET_KV_KEY);
  if (existingSecret) {
    return jsonError(
      409,
      "Worker is already configured — secret exists in KV. To re-setup, delete the KV key 'secret:cloud-sync' first."
    );
  }

  // ── Generate a new secret ──
  const secret = await generateRandomHex(32); // 64 hex chars = 32 bytes = 256 bits

  // ── Store in KV (persists across invocations) ──
  await env.BUNDLES.put(SECRET_KV_KEY, secret);

  // ── Set in env for this invocation so signResponse() works immediately ──
  // Note: This mutation only affects this request. Future requests will
  // read from KV via the getCloudSyncSecret() helper in hmac.ts.
  (env as { CLOUD_SYNC_SECRET?: string }).CLOUD_SYNC_SECRET = secret;

  // ── Return the secret (once — never again) ──
  const responseData = {
    success: true,
    message: "Secret generated and stored. Save it now — it will not be shown again.",
    secret,
    instructions:
      "Set this as OMNIROUTE_CLOUD_SYNC_SECRET in your local OmniRoute .env, or paste it in Settings → Cloud Sync → Secret.",
  };

  return new Response(JSON.stringify(responseData), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Generate a cryptographically random hex string of `bytes` bytes.
 * Uses Web Crypto API (available in Cloudflare Workers).
 */
async function generateRandomHex(bytes: number): Promise<string> {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  let hex = "";
  for (let i = 0; i < array.length; i++) {
    hex += array[i].toString(16).padStart(2, "0");
  }
  return hex;
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
