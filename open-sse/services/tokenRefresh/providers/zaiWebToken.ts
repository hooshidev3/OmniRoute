// @ts-nocheck
// Z.AI Web Token (user-supplied JWT) token refresh — see ../shared.ts for provenance.
//
// zai-web-token is the sibling of zai-web-free that uses a user-supplied
// Z.AI JWT instead of a Guest JWT. The JWT unlocks all GLM models but
// cannot be auto-refreshed (Z.AI does not expose a refresh_token grant for
// web sessions). When the JWT expires, the user must re-paste it from
// chat.z.ai → DevTools → Application → Cookies → token.
//
// This module exists so the shared tokenRefresh orchestrator has a uniform
// per-provider refresh function for every registered provider. It always
// returns `null` (no refresh possible) — the caller will mark the credential
// as expired and the dashboard will prompt the user to re-paste.

import type { RefreshLogger } from "../shared.ts";

/**
 * Refresh a Z.AI Web Token (user-supplied JWT).
 *
 * Always returns `null` — Z.AI web JWTs cannot be auto-refreshed.
 * The caller should mark the credential as expired and surface a
 * dashboard notification prompting the user to re-paste the JWT.
 */
export async function refreshZaiWebTokenToken(
  _refreshToken: string,
  _providerSpecificData: Record<string, unknown> | null,
  log: RefreshLogger,
  _proxyConfig: unknown = null
): Promise<null> {
  log?.warn?.(
    "TOKEN_REFRESH",
    "zai-web-token: user-supplied JWT cannot be auto-refreshed; user must re-paste when expired"
  );
  return null;
}
