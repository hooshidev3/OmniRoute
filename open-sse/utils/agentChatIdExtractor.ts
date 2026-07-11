/**
 * Agent Chat ID Extractor — Unified extraction of client-provided conversation
 * identifiers from AI agent requests.
 *
 * AI agents (Claude Code, Cursor, Cline, Roo Code, etc.) send conversation
 * identifiers in various locations:
 *   - Request body fields: `conversation_id`, `chat_id`, `session_id`,
 *     `conversationId`, `sessionId`
 *   - Metadata: `metadata.session_id`, `metadata.sessionId`
 *   - Headers: `x-session-id`, `x-codex-session-id`, `x-omniroute-session`
 *
 * This module provides a single function to extract the agent's chat_id,
 * which executors can use to look up or create a provider conversationId
 * via `providerSessionRegistry`.
 *
 * @module utils/agentChatIdExtractor
 */

export interface AgentChatIdSource {
  value: string;
  source: "body" | "metadata" | "header";
  field: string;
}

const BODY_CHAT_ID_FIELDS = [
  "conversation_id",
  "chat_id",
  "session_id",
  "conversationId",
  "sessionId",
] as const;

const METADATA_CHAT_ID_FIELDS = ["session_id", "sessionId"] as const;

const HEADER_CHAT_ID_NAMES = ["x-session-id", "x-codex-session-id", "x-omniroute-session"] as const;

function readHeaderValue(
  headers:
    | Headers
    | { get?: (name: string) => string | null }
    | Record<string, unknown>
    | null
    | undefined,
  name: string
): string | null {
  if (!headers) return null;
  if (typeof (headers as Headers).get === "function") {
    const value = (headers as Headers).get(name);
    return value && value.trim() ? value.trim() : null;
  }
  if (typeof headers === "object") {
    const lowered = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === lowered && typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  }
  return null;
}

function extractStringValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return null;
}

export function extractAgentChatId(
  body: unknown,
  headers?: Headers | { get?: (name: string) => string | null } | Record<string, unknown> | null
): AgentChatIdSource | null {
  // 1. Body fields
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    for (const field of BODY_CHAT_ID_FIELDS) {
      const value = extractStringValue(record[field]);
      if (value) return { value, source: "body", field };
    }

    // 2. Metadata
    const metadata = record.metadata;
    if (metadata && typeof metadata === "object") {
      const metaRecord = metadata as Record<string, unknown>;
      for (const field of METADATA_CHAT_ID_FIELDS) {
        const value = extractStringValue(metaRecord[field]);
        if (value) return { value, source: "metadata", field };
      }
    }
  }

  // 3. Headers
  for (const headerName of HEADER_CHAT_ID_NAMES) {
    const value = readHeaderValue(headers, headerName);
    if (value) return { value, source: "header", field: headerName };
  }

  return null;
}

export function getAgentChatId(
  body: unknown,
  headers?: Headers | { get?: (name: string) => string | null } | Record<string, unknown> | null
): string | null {
  return extractAgentChatId(body, headers)?.value ?? null;
}

export function hasAgentChatId(
  body: unknown,
  headers?: Headers | { get?: (name: string) => string | null } | Record<string, unknown> | null
): boolean {
  return extractAgentChatId(body, headers) !== null;
}
