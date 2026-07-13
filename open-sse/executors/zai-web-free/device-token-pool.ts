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
 * @module zai-web-free/device-token-pool
 */

import { logger } from "../../utils/logger.ts";

const log = logger("ZAI-WEB-FREE");

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
      // Ensure our table exists (idempotent)
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS zai_web_free_device_tokens (
            id    INTEGER PRIMARY KEY AUTOINCREMENT,
            token TEXT NOT NULL UNIQUE,
            added_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
          CREATE INDEX IF NOT EXISTS idx_zai_tokens_id ON zai_web_free_device_tokens(id);
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
 * Get the next device token from the pool (FIFO order). Returns `null` if
 * the pool is empty.
 */
export function getNextToken(): string | null {
  // In-memory fallback when no DB is configured
  if (!_pendingAdds.isEmpty) {
    // try DB first
  }
  const db = getDb();
  if (!db) {
    return _pendingAdds.shift() ?? null;
  }
  try {
    const row = db
      .prepare("SELECT token FROM zai_web_free_device_tokens ORDER BY id LIMIT 1")
      .get() as { token: string } | undefined;
    return row?.token ?? null;
  } catch (err) {
    log.error?.("pool.next_failed", { error: err instanceof Error ? err.message : String(err) });
    return _pendingAdds.shift() ?? null;
  }
}

/**
 * Remove a token from the pool after it has been used (success or failure).
 */
export function consumeToken(token: string): void {
  const db = getDb();
  if (!db) {
    // In-memory fallback: no-op (already shifted in getNextToken)
    return;
  }
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
 * Get the current pool size (number of tokens available).
 */
export function getPoolSize(): number {
  const db = getDb();
  if (!db) return _pendingAdds.length;
  try {
    const row = db.prepare("SELECT COUNT(*) as count FROM zai_web_free_device_tokens").get() as
      { count: number } | undefined;
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
