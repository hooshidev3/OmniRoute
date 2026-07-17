/**
 * Provider Session Registry — Maps agent chat_id to provider conversationId.
 *
 * L1: In-memory LRU cache (1000 entries, fast path)
 * L2: SQLite table `provider_session_mappings` (survives restart)
 * L3: Fallback — generate fresh providerConversationId
 *
 * @module services/providerSessionRegistry
 */

import { randomUUID } from "node:crypto";

export interface ProviderSessionMapping {
  connectionId: string;
  agentChatId: string;
  provider: string;
  providerConversationId: string;
  metadata: Record<string, unknown> | null;
  createdAt: number;
  lastUsedAt: number;
}

export interface MappingKey {
  connectionId: string;
  agentChatId: string;
  provider: string;
}

export interface SaveMappingOptions {
  connectionId: string;
  agentChatId: string;
  provider: string;
  providerConversationId: string;
  metadata?: Record<string, unknown>;
}

export interface GetOrCreateOptions extends MappingKey {
  generateId: () => string;
  metadata?: Record<string, unknown>;
}

// ── L1: In-memory LRU ──────────────────────────────────────────────────────

const LRU_MAX_SIZE = 1000;

interface LruEntry {
  mapping: ProviderSessionMapping;
  order: number;
}

const _lruCache = new Map<string, LruEntry>();
let _lruCounter = 0;

function lruKey(key: MappingKey): string {
  return `${key.connectionId}:${key.agentChatId}:${key.provider}`;
}

function lruGet(key: MappingKey): ProviderSessionMapping | null {
  const entry = _lruCache.get(lruKey(key));
  if (!entry) return null;
  entry.order = ++_lruCounter;
  entry.mapping.lastUsedAt = Date.now();
  return { ...entry.mapping };
}

function lruSet(mapping: ProviderSessionMapping): void {
  const cacheKey = lruKey(mapping);
  _lruCache.set(cacheKey, { mapping: { ...mapping }, order: ++_lruCounter });
  if (_lruCache.size > LRU_MAX_SIZE) {
    let oldestKey: string | null = null;
    let oldestOrder = Infinity;
    for (const [k, v] of _lruCache) {
      if (v.order < oldestOrder) {
        oldestOrder = v.order;
        oldestKey = k;
      }
    }
    if (oldestKey) _lruCache.delete(oldestKey);
  }
}

function lruDelete(key: MappingKey): void {
  _lruCache.delete(lruKey(key));
}

// ── L2: SQLite ─────────────────────────────────────────────────────────────

interface DbLike {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

function getDb(): DbLike | null {
  try {
    const db = (globalThis as unknown as { __omnirouteDb?: DbLike }).__omnirouteDb;
    return db ?? null;
  } catch {
    return null;
  }
}

interface MappingRow {
  connection_id: string;
  agent_chat_id: string;
  provider: string;
  provider_conversation_id: string;
  metadata_json: string | null;
  created_at: string;
  last_used_at: string;
}

function toMapping(row: MappingRow): ProviderSessionMapping {
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata_json) {
    try {
      metadata = JSON.parse(row.metadata_json);
    } catch {
      metadata = null;
    }
  }
  return {
    connectionId: row.connection_id,
    agentChatId: row.agent_chat_id,
    provider: row.provider,
    providerConversationId: row.provider_conversation_id,
    metadata,
    createdAt: new Date(row.created_at + "Z").getTime(),
    lastUsedAt: new Date(row.last_used_at + "Z").getTime(),
  };
}

function dbGet(key: MappingKey): ProviderSessionMapping | null {
  const db = getDb();
  if (!db) return null;
  try {
    const row = db
      .prepare(
        "SELECT connection_id, agent_chat_id, provider, provider_conversation_id, metadata_json, created_at, last_used_at FROM provider_session_mappings WHERE connection_id = ? AND agent_chat_id = ? AND provider = ?"
      )
      .get(key.connectionId, key.agentChatId, key.provider) as MappingRow | undefined;
    return row ? toMapping(row) : null;
  } catch {
    return null;
  }
}

function dbSave(mapping: ProviderSessionMapping): void {
  const db = getDb();
  if (!db) return;
  try {
    const metadataJson = mapping.metadata ? JSON.stringify(mapping.metadata) : null;
    db.prepare(
      "INSERT OR REPLACE INTO provider_session_mappings (connection_id, agent_chat_id, provider, provider_conversation_id, metadata_json, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
    ).run(
      mapping.connectionId,
      mapping.agentChatId,
      mapping.provider,
      mapping.providerConversationId,
      metadataJson
    );
  } catch {
    /* best-effort */
  }
}

function dbUpdateLastUsed(key: MappingKey): void {
  const db = getDb();
  if (!db) return;
  try {
    db.prepare(
      "UPDATE provider_session_mappings SET last_used_at = datetime('now') WHERE connection_id = ? AND agent_chat_id = ? AND provider = ?"
    ).run(key.connectionId, key.agentChatId, key.provider);
  } catch {
    /* best-effort */
  }
}

function dbDelete(key: MappingKey): void {
  const db = getDb();
  if (!db) return;
  try {
    db.prepare(
      "DELETE FROM provider_session_mappings WHERE connection_id = ? AND agent_chat_id = ? AND provider = ?"
    ).run(key.connectionId, key.agentChatId, key.provider);
  } catch {
    /* best-effort */
  }
}

function dbUpdateMetadata(key: MappingKey, metadata: Record<string, unknown>): void {
  const db = getDb();
  if (!db) return;
  try {
    db.prepare(
      "UPDATE provider_session_mappings SET metadata_json = ?, last_used_at = datetime('now') WHERE connection_id = ? AND agent_chat_id = ? AND provider = ?"
    ).run(JSON.stringify(metadata), key.connectionId, key.agentChatId, key.provider);
  } catch {
    /* best-effort */
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export function getMapping(key: MappingKey): ProviderSessionMapping | null {
  const cached = lruGet(key);
  if (cached) {
    dbUpdateLastUsed(key);
    return cached;
  }
  const fromDb = dbGet(key);
  if (fromDb) {
    lruSet(fromDb);
    return fromDb;
  }
  return null;
}

export function getOrCreateMapping(options: GetOrCreateOptions): ProviderSessionMapping {
  const key: MappingKey = {
    connectionId: options.connectionId,
    agentChatId: options.agentChatId,
    provider: options.provider,
  };
  const existing = getMapping(key);
  if (existing) return existing;

  const now = Date.now();
  const newMapping: ProviderSessionMapping = {
    connectionId: options.connectionId,
    agentChatId: options.agentChatId,
    provider: options.provider,
    providerConversationId: options.generateId(),
    metadata: options.metadata ?? null,
    createdAt: now,
    lastUsedAt: now,
  };
  lruSet(newMapping);
  dbSave(newMapping);
  return newMapping;
}

export function saveMapping(options: SaveMappingOptions): ProviderSessionMapping {
  const now = Date.now();
  const mapping: ProviderSessionMapping = {
    connectionId: options.connectionId,
    agentChatId: options.agentChatId,
    provider: options.provider,
    providerConversationId: options.providerConversationId,
    metadata: options.metadata ?? null,
    createdAt: now,
    lastUsedAt: now,
  };
  lruSet(mapping);
  dbSave(mapping);
  return mapping;
}

export function updateMetadata(key: MappingKey, metadata: Record<string, unknown>): void {
  const entry = _lruCache.get(lruKey(key));
  if (entry) {
    entry.mapping.metadata = { ...metadata };
    entry.mapping.lastUsedAt = Date.now();
    entry.order = ++_lruCounter;
  }
  dbUpdateMetadata(key, metadata);
}

export function deleteMapping(key: MappingKey): void {
  lruDelete(key);
  dbDelete(key);
}

export function deleteConnectionMappings(connectionId: string): void {
  const keysToDelete: string[] = [];
  for (const [k] of _lruCache) {
    if (k.startsWith(`${connectionId}:`)) keysToDelete.push(k);
  }
  for (const k of keysToDelete) _lruCache.delete(k);
  const db = getDb();
  if (!db) return;
  try {
    db.prepare("DELETE FROM provider_session_mappings WHERE connection_id = ?").run(connectionId);
  } catch {
    /* best-effort */
  }
}

export function __clearLruCacheForTest(): void {
  _lruCache.clear();
  _lruCounter = 0;
}

export function getLruCacheStats(): { size: number; maxSize: number } {
  return { size: _lruCache.size, maxSize: LRU_MAX_SIZE };
}
