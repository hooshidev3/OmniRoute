// @ts-nocheck
// Z.AI Web Free (captcha-based) token refresh — see ../shared.ts for provenance.
//
// Unlike OAuth providers, zai-web-free uses a Guest JWT obtained from
// /api/v1/auths/guest. Guest JWTs do not have a refresh_token flow; instead,
// this module re-issues a fresh Guest JWT when the current one is close to
// expiry. The Guest JWT has no expires_in claim (or a very long one), so
// refresh is rare in practice — but if the user supplied a personal Z.AI JWT
// (zai-web-token variant), refresh_token grant is not supported either; the
// user must re-paste the JWT manually when it expires.
//
// This module is wired through the shared tokenRefresh orchestrator so that
// the dedup/mutex/CAS-guard layers apply (prevents concurrent refresh storms
// if multiple requests arrive while the Guest JWT is being renewed).

import { runWithProxyContext } from "../../../utils/proxyFetch.ts";
import type { RefreshLogger } from "../shared.ts";

const ZAI_BASE_URL = "https://chat.z.ai";
const GUEST_AUTH_URL = `${ZAI_BASE_URL}/api/v1/auths/guest`;

export interface ZaiWebFreeRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
  providerSpecificData?: Record<string, unknown>;
}

/**
 * Refresh a Z.AI Web Free guest JWT.
 *
 * - If `providerSpecificData.token` is set (user-supplied JWT, zai-web-token),
 *   the JWT is returned as-is — personal JWTs do not support refresh; the
 *   user must re-paste when expired. Caller should mark as unrecoverable.
 * - Otherwise, calls /api/v1/auths/guest to mint a fresh Guest JWT.
 *
 * Returns `null` to signal "no refresh possible" (caller keeps the existing
 * credential). Throws on network errors.
 */
export async function refreshZaiWebFreeToken(
  _refreshToken: string,
  providerSpecificData: Record<string, unknown> | null,
  log: RefreshLogger,
  proxyConfig: unknown = null
): Promise<ZaiWebFreeRefreshResult | null> {
  // User-supplied JWT (zai-web-token variant): no refresh possible.
  if (providerSpecificData?.token) {
    log?.warn?.(
      "TOKEN_REFRESH",
      "zai-web-token: user-supplied JWT cannot be auto-refreshed; user must re-paste when expired"
    );
    return null;
  }

  // Guest JWT: mint a fresh one.
  log?.info?.("TOKEN_REFRESH", "zai-web-free: minting fresh Guest JWT");

  const response = await runWithProxyContext(proxyConfig, () =>
    fetch(GUEST_AUTH_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
      },
    })
  );

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    log?.error?.(
      "TOKEN_REFRESH",
      `zai-web-free: guest JWT mint failed: HTTP ${response.status}: ${errText.slice(0, 200)}`
    );
    return null;
  }

  const data = (await response.json()) as { token?: string };
  if (!data.token || typeof data.token !== "string") {
    log?.error?.("TOKEN_REFRESH", "zai-web-free: guest JWT mint returned no token");
    return null;
  }

  // Guest JWT has no expiry claim — assume 24h (matches observed chat.z.ai behavior).
  return {
    accessToken: data.token,
    refreshToken: null,
    expiresIn: 24 * 60 * 60,
    providerSpecificData: {
      // Preserve any user-set keys (except `token` which we just refreshed).
      ...providerSpecificData,
      token: data.token,
    },
  };
}
