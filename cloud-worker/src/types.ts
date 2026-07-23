/**
 * Type definitions for the OmniRoute Cloud Worker.
 */

/** A provider connection from the sync bundle. */
export interface BundleProvider {
  id: string;
  provider: string;
  authType?: string;
  name?: string;
  apiKey?: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  defaultModel?: string | null;
  isActive?: boolean;
  testStatus?: string;
  providerSpecificData?: Record<string, unknown>;
  priority?: number;
  globalPriority?: number | null;
}

/** An API key from the sync bundle. */
export interface BundleApiKey {
  id: string;
  name?: string;
  key: string;
  machineId?: string;
  isActive?: boolean;
  allowedModels?: string[];
  allowedCombos?: string[];
  allowedConnections?: string[];
  /** Whether this is a management-scope key (bypasses ACL checks). */
  isManagement?: boolean;
  /** Throttle: minimum ms between requests. 0 = no throttle. */
  throttleDelayMs?: number;
  /** Rate limit: max requests per minute. 0 = unlimited. */
  maxRequestsPerMinute?: number;
  /** Rate limit: max requests per day. 0 = unlimited. */
  maxRequestsPerDay?: number;
  /** Access schedule (cron-like). Undefined = always allowed. */
  accessSchedule?: {
    daysOfWeek?: number[]; // 0=Sun, 6=Sat
    startHour?: number; // 0-23
    endHour?: number; // 0-23
    timezone?: string;
  };
  /** Whether to log requests made with this key. */
  noLog?: boolean;
}

/** A combo from the sync bundle. */
export interface BundleCombo {
  id: string;
  name?: string;
  strategy?: string;
  models?: unknown[];
  sortOrder?: number;
}

/** A reasoning routing rule from the sync bundle. */
export interface BundleReasoningRule {
  id: string;
  name?: string;
  description?: string;
  scope?: string; // "global" | "apiKey" | "combo" | "connection"
  apiKeyId?: string;
  comboId?: string;
  connectionId?: string;
  modelPattern?: string;
  sourceEffort?: string;
  requestTags?: string[];
  tagMatchMode?: string; // "any" | "all" | "none"
  effortMode?: string; // "map" | "strip" | "passthrough"
  targetEffort?: string; // "low" | "medium" | "high" | "xhigh" | "max"
  targetKind?: string; // "model" | "combo"
  targetModel?: string;
  targetComboId?: string;
  budgetAction?: string;
  budgetTokens?: number;
  priority?: number;
  enabled?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** The full sync bundle stored in KV. */
export interface SyncBundle {
  version: string;
  providers: BundleProvider[];
  providerNodes?: unknown[];
  modelAliases?: Record<string, unknown>;
  combos: BundleCombo[];
  apiKeys: BundleApiKey[];
  settings: Record<string, unknown>;
  /** Reasoning routing rules — applied before forwarding to upstream. */
  reasoningRoutingRules?: BundleReasoningRule[];
  /** Timestamp of last sync (ISO string). */
  syncedAt?: string;
}

/** The response to a sync POST. */
export interface SyncResponse {
  success: boolean;
  message: string;
  version?: string;
  changes?: Record<string, unknown>;
  data?: {
    providers?: BundleProvider[];
  };
  createdKey?: string;
}

/** Environment bindings for the worker. */
export interface Env {
  BUNDLES: KVNamespace;
  CLOUD_SYNC_SECRET: string;
  ALLOWED_UPSTREAM_HOSTS?: string;
}
