/**
 * Device-token pool — backed by the OmniRoute main SQLite database.
 *
 * Device tokens are required by the Aliyun captcha verification step. They
 * are obtained by running a Playwright script that visits chat.z.ai and
 * extracts `window.z_um.getToken()` values from the browser context. The
 * tokens are consumed FIFO and deleted after use (one token per captcha
 * verification attempt, up to 2 attempts per chat request).
 *
 * Uses the same `globalThis.__omnirouteDb` pattern as
 * `providerSessionRegistry.ts` — no separate DB file, no directory issues.
 *
 * ## TTL eviction (#C)
 * Z.AI device tokens have a short lifetime (~10-30 minutes). The pool
 * tracks `added_at` and `getNextToken()` filters out tokens older than
 * `TOKEN_TTL_MS` (default 25 minutes). `evictExpiredTokens()` is called
 * lazily on every read and can be invoked explicitly by the auto-refresh
 * daemon. Tokens whose `added_at` is unknown (NULL / legacy rows) are
 * treated as fresh to avoid mass eviction on first deploy of this code.
 *
 * ## Atomic consume (#D)
 * `getNextToken()` used to do `SELECT...LIMIT 1` without a lock, so two
 * concurrent requests could pick the same token. It now uses an atomic
 * `DELETE...ORDER BY id LIMIT 1 RETURNING token` so the consume is a
 * single SQL statement — no separate `consumeToken()` call is needed for
 * the common path. `consumeToken()` is kept for backward compat with
 * callers that explicitly fail after the consume.
 *
 * @module zai-web-free/device-token-pool
 */

import { logger } from "../../utils/logger.ts";

const log = logger("ZAI-WEB-FREE");

/**
 * Maximum age of a device token before it is considered stale and evicted.
 * Default: 25 minutes. Z.AI tokens appear to live ~30 minutes; we evict a
 * touch early so a request never picks a token that will expire mid-flight.
 * Overridable via `OMNIROUTE_ZAI_WEB_FREE_TOKEN_TTL_MS` for operators who
 * observe different expiry behavior.
 */
const TOKEN_TTL_MS = (() => {
  const raw = process.env.OMNIROUTE_ZAI_WEB_FREE_TOKEN_TTL_MS;
  if (raw) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 25 * 60 * 1000; // 25 minutes
})();

// ── DB access via globalThis.__omnirouteDb (same as providerSessionRegistry) ──

interface DbLike {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  exec(sql: string): void;
  transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T;
}

function getDb(): DbLike | null {
  try {
    const db = (globalThis as unknown as { __omnirouteDb?: DbLike }).__omnirouteDb;
    if (db) {
      // Ensure our table exists (idempotent). The added_at column is
      // critical for TTL eviction — older rows that pre-date this column
      // get a default of datetime('now'), which is fine (treated as fresh).
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS zai_web_free_device_tokens (
            id    INTEGER PRIMARY KEY AUTOINCREMENT,
            token TEXT NOT NULL UNIQUE,
            added_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
          CREATE INDEX IF NOT EXISTS idx_zai_tokens_id ON zai_web_free_device_tokens(id);
          CREATE INDEX IF NOT EXISTS idx_zai_tokens_added_at
            ON zai_web_free_device_tokens(added_at);
        `);
      } catch {
        // Table may already exist, or DB is read-only (build phase)
      }
      return db;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * SQLite UTC datetime string for `Date.now() - TOKEN_TTL_MS`.
 * Format matches `datetime('now')` → `YYYY-MM-DD HH:MM:SS`.
 */
function ttlCutoffUtc(): string {
  const cutoffMs = Date.now() - TOKEN_TTL_MS;
  const d = new Date(cutoffMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

/**
 * Lazily delete tokens older than `TOKEN_TTL_MS`. Called from `getNextToken`
 * and `getPoolSize`. Safe to call repeatedly — uses a single `DELETE` with
 * a `WHERE added_at < ?` predicate. Returns the number of rows evicted.
 */
export function evictExpiredTokens(): number {
  const db = getDb();
  if (!db) return 0;
  try {
    const cutoff = ttlCutoffUtc();
    const result = db
      .prepare("DELETE FROM zai_web_free_device_tokens WHERE added_at < ?")
      .run(cutoff);
    if (result.changes > 0) {
      log.info?.("pool.evicted", { count: result.changes, cutoff });
    }
    return result.changes;
  } catch (err) {
    log.error?.("pool.evict_failed", { error: err instanceof Error ? err.message : String(err) });
    return 0;
  }
}

// ── In-memory fallback (for tests / when DB is not available) ──
const _pendingAdds: string[] = [];

/**
 * Initialize the device-token pool. Kept for backward compatibility —
 * the pool now uses globalThis.__omnirouteDb, so no path is needed.
 */
export function initDeviceTokenPool(_dbPath?: string): void {
  // No-op — DB is accessed via globalThis.__omnirouteDb
}

/**
 * Atomically take the next device token from the pool (FIFO order) and
 * delete it so no concurrent request can pick the same token. Returns
 * `null` if the pool is empty (after TTL eviction).
 *
 * Implementation: `DELETE...ORDER BY id LIMIT 1 RETURNING token` is a
 * single atomic statement in SQLite — no race between SELECT and DELETE.
 * Falls back to the legacy SELECT+consume path on older SQLite builds
 * that don't support `RETURNING` (SQLite < 3.35).
 *
 * TTL filter: tokens with `added_at < now - TOKEN_TTL_MS` are excluded.
 * A separate `evictExpiredTokens()` call keeps the table from growing
 * unboundedly, but the filter here is the correctness boundary.
 */
export function getNextToken(): string | null {
  // Lazily evict expired tokens so the pool size and the next-pick stay
  // accurate even if no daemon is running.
  evictExpiredTokens();

  const db = getDb();
  if (!db) {
    return _pendingAdds.shift() ?? null;
  }
  const cutoff = ttlCutoffUtc();
  try {
    // Try the atomic RETURNING path first (SQLite ≥ 3.35, 2021-03).
    // better-sqlite3 ships with SQLite 3.40+, so this should always work.
    const row = db
      .prepare(
        `DELETE FROM zai_web_free_device_tokens
         WHERE id = (
           SELECT id FROM zai_web_free_device_tokens
           WHERE added_at >= ?
           ORDER BY id
           LIMIT 1
         )
         RETURNING token`
      )
      .get(cutoff) as { token: string } | undefined;
    if (row?.token) return row.token;
    // No fresh token in DB; fall through to in-memory fallback.
    return _pendingAdds.shift() ?? null;
  } catch (err) {
    // Fallback: older SQLite without RETURNING support. Use the legacy
    // non-atomic SELECT + consume path. This is racy under concurrency
    // but preserves correctness for single-request flows.
    log.warn?.("pool.returning_unsupported_fallback", {
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      const row = db
        .prepare(
          `SELECT token, id FROM zai_web_free_device_tokens
           WHERE added_at >= ?
           ORDER BY id
           LIMIT 1`
        )
        .get(cutoff) as { token: string; id: number } | undefined;
      if (!row?.token) return _pendingAdds.shift() ?? null;
      db.prepare("DELETE FROM zai_web_free_device_tokens WHERE id = ?").run(row.id);
      return row.token;
    } catch (err2) {
      log.error?.("pool.next_failed", {
        error: err2 instanceof Error ? err2.message : String(err2),
      });
      return _pendingAdds.shift() ?? null;
    }
  }
}

/**
 * Remove a token from the pool after it has been used.
 *
 * Note: `getNextToken()` already atomically deletes the token in the same
 * statement (via `DELETE...RETURNING`), so this function is only needed
 * for callers that obtained a token via a non-atomic path or want to
 * explicitly invalidate a known token string. It is a no-op when the token
 * is no longer present (already consumed by the atomic path).
 */
export function consumeToken(token: string): void {
  const db = getDb();
  if (!db) return;
  try {
    db.prepare("DELETE FROM zai_web_free_device_tokens WHERE token = ?").run(token);
  } catch (err) {
    log.error?.("pool.consume_failed", { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Add new device tokens to the pool.
 *
 * @returns The number of tokens actually added (duplicates excluded).
 */
export function addDeviceTokens(tokens: string[]): number {
  if (tokens.length === 0) return 0;

  // In-memory fallback
  const db = getDb();
  if (!db) {
    let added = 0;
    for (const t of tokens) {
      if (!_pendingAdds.includes(t)) {
        _pendingAdds.push(t);
        added++;
      }
    }
    return added;
  }

  try {
    const stmt = db.prepare("INSERT OR IGNORE INTO zai_web_free_device_tokens (token) VALUES (?)");
    let added = 0;
    const tx = db.transaction((toks: string[]) => {
      for (const t of toks) {
        const result = stmt.run(t);
        if (result.changes > 0) added++;
      }
    });
    tx(tokens);
    log.info?.("pool.tokens_added", { count: added, totalRequested: tokens.length });
    return added;
  } catch (err) {
    log.error?.("pool.add_failed", { error: err instanceof Error ? err.message : String(err) });
    return 0;
  }
}

/**
 * Get the current pool size (number of fresh tokens available).
 *
 * Counts only tokens with `added_at >= now - TOKEN_TTL_MS` so the dashboard
 * reflects what the executor will actually be able to use. Also lazily
 * evicts expired tokens so the on-disk table stays bounded.
 */
export function getPoolSize(): number {
  evictExpiredTokens();
  const db = getDb();
  if (!db) return _pendingAdds.length;
  try {
    const cutoff = ttlCutoffUtc();
    const row = db
      .prepare(`SELECT COUNT(*) as count FROM zai_web_free_device_tokens WHERE added_at >= ?`)
      .get(cutoff) as { count: number } | undefined;
    return row?.count ?? 0;
  } catch {
    return _pendingAdds.length;
  }
}

/**
 * Clear all tokens from the pool.
 */
export function clearPool(): void {
  const db = getDb();
  if (!db) {
    _pendingAdds.length = 0;
    return;
  }
  try {
    db.prepare("DELETE FROM zai_web_free_device_tokens").run();
    log.info?.("pool.cleared");
  } catch (err) {
    log.error?.("pool.clear_failed", { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Close the database handle. No-op now — DB lifecycle is managed by core.
 */
export function closeDeviceTokenPool(): void {
  // No-op — DB lifecycle is managed by OmniRoute core
}
