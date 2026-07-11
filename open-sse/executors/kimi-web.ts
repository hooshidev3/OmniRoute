/**
 * KimiWebExecutor — Moonshot AI Chat via www.kimi.com (international)
 *
 * Routes requests through Kimi's consumer chat API on the international domain.
 *
 * Auth: `Authorization: Bearer <JWT>` + `Cookie: kimi-auth=<JWT>`. The JWT is
 * extracted from whatever the user pasted (bare JWT, full Cookie header, or
 * `Bearer <jwt>`).
 *
 * Protocol: Connect-RPC streaming (5-byte envelope header + JSON).
 *   - Endpoint: POST /apiv2/kimi.gateway.chat.v1.ChatService/Chat
 *   - Body: Connect-framed JSON with scenario, message, options, tools
 *   - Response: Connect-framed stream of events carrying deltas
 *
 * Models (from GetAvailableModels):
 *   - k2d6           — SCENARIO_K2D5 (default chat)
 *   - k2d6-thinking  — SCENARIO_K2D5 + thinking:true
 *   - k2d6-agent     — SCENARIO_OK_COMPUTER + kimiPlusId:"ok-computer" + agentMode:TYPE_NORMAL
 *   - k2d6-agent-ultra — SCENARIO_OK_COMPUTER + kimiPlusId:"ok-computer" + agentMode:TYPE_ULTRA
 *
 * Multi-turn: server-generated chat.id captured from response frame, stored in
 * providerSessionRegistry keyed by agentChatId. Subsequent turns pass chat_id
 * in the request body to continue the conversation.
 *
 * Session persistence (aligned with deepseek-web #2942):
 *   - persistSession=false (default): delete chat after response
 *   - persistSession=true: keep chat on platform for reuse
 *
 * Tool calling:
 *   - Function tools: OmniRoute native <tool>{json}</tool> protocol (webTools.ts)
 *   - Web search: TOOL_TYPE_SEARCH gated by hasNativeWebSearchTool(); results
 *     surfaced as [n]: [title](url) citations
 *   - Agent tool calls (block.tool.args/contents): forwarded as OpenAI tool_calls
 *
 * Think mode: 3 modes (passthrough/strip/separate) via thinkModeProcessor.
 *
 * Image upload: 3-step (pre-sign-url → PUT → /api/file), then file.id block.
 */
import { BaseExecutor, type ExecuteInput, type ProviderCredentials } from "./base.ts";
import {
  makeExecutorErrorResult as makeErrorResult,
  sanitizeErrorMessage,
} from "../utils/error.ts";
import { extractKimiJwt } from "@/lib/providers/webCookieAuth";
import { prepareToolMessages, buildToolAwareResult } from "../translator/webTools.ts";
import { buildToolModeResponse } from "./chatgptWebTools.ts";
import { hasNativeWebSearchTool } from "../services/webSearchRouting.ts";
import { getAgentChatId } from "../utils/agentChatIdExtractor.ts";
import { getMapping, saveMapping } from "../services/providerSessionRegistry.ts";
import {
  applyThinkMode,
  createThinkStreamContext,
  processThinkStreamDelta,
  flushThinkStream,
} from "../utils/thinkModeProcessor.ts";
import { resolveThinkMode } from "../services/thinkOutputMode.ts";

export { extractKimiJwt };

// ── Constants ──────────────────────────────────────────────────────────────

const BASE_URL = "https://www.kimi.com";
const CHAT_URL = `${BASE_URL}/apiv2/kimi.gateway.chat.v1.ChatService/Chat`;
const DELETE_URL = `${BASE_URL}/apiv2/kimi.chat.v1.ChatService/DeleteChat`;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

// ── Types ──────────────────────────────────────────────────────────────────

interface OpenAIMessage {
  role: string;
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
}

export interface KimiModelConfig {
  scenario: string;
  thinking: boolean;
  kimiPlusId?: string;
  agentMode?: string;
}

/**
 * Resolve model config (scenario + thinking + agent fields) from model id.
 * Values derived from GetAvailableModels response.
 */
export function resolveModelConfig(modelId: string): KimiModelConfig {
  const id = (modelId || "").toLowerCase();
  if (id === "k2d6-thinking") return { scenario: "SCENARIO_K2D5", thinking: true };
  if (id === "k2d6-agent")
    return {
      scenario: "SCENARIO_OK_COMPUTER",
      thinking: false,
      kimiPlusId: "ok-computer",
      agentMode: "TYPE_NORMAL",
    };
  if (id === "k2d6-agent-ultra")
    return {
      scenario: "SCENARIO_OK_COMPUTER",
      thinking: false,
      kimiPlusId: "ok-computer",
      agentMode: "TYPE_ULTRA",
    };
  // k2d6 and any unknown id fall back to default chat
  return { scenario: "SCENARIO_K2D5", thinking: false };
}

// ── Connect-RPC framing ────────────────────────────────────────────────────

/** Wrap a JSON message in the 5-byte Connect streaming envelope (flags + length). */
export function frameConnectMessage(json: string): Uint8Array {
  const payload = new TextEncoder().encode(json);
  const framed = new Uint8Array(5 + payload.length);
  framed[0] = 0; // flags: 0 = uncompressed
  const len = payload.length;
  framed[1] = (len >>> 24) & 0xff;
  framed[2] = (len >>> 16) & 0xff;
  framed[3] = (len >>> 8) & 0xff;
  framed[4] = len & 0xff;
  framed.set(payload, 5);
  return framed;
}

interface ConnectFrame {
  flags: number;
  message: Record<string, unknown> | null;
}

/** Cap a single Connect frame at 8 MiB to prevent OOM attacks. */
const MAX_FRAME_LEN = 8 * 1024 * 1024;

/**
 * Decode one Connect frame from a stream buffer.
 * Returns consumed:0 if more bytes needed, consumed:-1 on oversized frame.
 */
export function decodeConnectFrame(
  buf: Uint8Array,
  byteOffset: number
): { consumed: number; frame: ConnectFrame | null } {
  if (byteOffset + 5 > buf.length) return { consumed: 0, frame: null };
  const flags = buf[byteOffset];
  const len =
    (buf[byteOffset + 1] << 24) |
    (buf[byteOffset + 2] << 16) |
    (buf[byteOffset + 3] << 8) |
    buf[byteOffset + 4];
  const msgLen = len < 0 ? len + 0x100000000 : len;
  if (msgLen > MAX_FRAME_LEN) return { consumed: -1, frame: null };
  if (byteOffset + 5 + msgLen > buf.length) return { consumed: 0, frame: null };

  const payload = buf.subarray(byteOffset + 5, byteOffset + 5 + msgLen);
  let message: Record<string, unknown> | null = null;
  if (msgLen > 0) {
    try {
      message = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      message = null;
    }
  }
  return { consumed: 5 + msgLen, frame: { flags, message } };
}

// ── Delta extraction ───────────────────────────────────────────────────────

type DeltaKind = "text" | "think" | null;

/**
 * Kimi stream error classification.
 * Kimi returns errors INSIDE the Connect-RPC stream (HTTP 200), not via HTTP
 * status codes. We classify them into:
 *   - "transient"  → retryable (server overload, temporary rate limit)
 *   - "paywall"    → permanent for free tier (needs subscription)
 *   - "auth"       → JWT expired/invalid
 *   - "fatal"      → unknown/other
 */
export type KimiErrorKind = "transient" | "paywall" | "auth" | "fatal" | null;

export interface KimiStreamError {
  kind: KimiErrorKind;
  code: string;
  message: string;
  reason?: string;
}

/**
 * Detect an error frame in the Connect-RPC stream.
 * Error frames have the shape: `{ error: { code: "...", details: [...] } }`
 * Returns null if the frame is not an error.
 */
export function extractStreamError(msg: Record<string, unknown> | null): KimiStreamError | null {
  if (!msg) return null;
  const err = msg.error as Record<string, unknown> | undefined;
  if (!err) return null;

  const code = String(err.code ?? "");
  const details = Array.isArray(err.details) ? err.details : [];
  let reason = "";
  let message = code;

  for (const d of details) {
    if (d && typeof d === "object") {
      const dbg = (d as Record<string, unknown>).debug as Record<string, unknown> | undefined;
      if (dbg) {
        reason = String(dbg.reason ?? "");
        const loc = dbg.localizedMessage as Record<string, unknown> | undefined;
        if (loc && typeof loc.message === "string") message = loc.message;
        // If paywall is present, it's a permanent block for free users
        if (dbg.paywall) {
          return { kind: "paywall", code, message, reason };
        }
      }
    }
  }

  // Classify by code
  if (code === "resource_exhausted") {
    // Could be transient (server overload) or paywall (handled above)
    return { kind: "transient", code, message, reason };
  }
  if (code === "unauthenticated" || code === "permission_denied") {
    return { kind: "auth", code, message, reason };
  }
  if (code === "unavailable" || code === "deadline_exceeded") {
    return { kind: "transient", code, message, reason };
  }

  return { kind: "fatal", code, message, reason };
}

/**
 * Extract a content delta + kind from a Connect frame message.
 * Handles both op:"set" (initial) and op:"append" (incremental) on
 * block.text.content / block.think.content masks.
 */
export function extractDelta(
  msg: Record<string, unknown> | null
): { kind: DeltaKind; text: string } | null {
  if (!msg) return null;
  const op = String(msg.op ?? "");
  const mask = String(msg.mask ?? "");
  const block = (msg.block ?? {}) as Record<string, unknown>;

  if (op === "append") {
    if (mask === "block.text.content") {
      const text = String(((block.text ?? {}) as Record<string, unknown>).content ?? "");
      return text ? { kind: "text", text } : null;
    }
    if (mask === "block.think.content") {
      const text = String(((block.think ?? {}) as Record<string, unknown>).content ?? "");
      return text ? { kind: "think", text } : null;
    }
    return null;
  }

  if (op === "set") {
    if (mask === "block.text") {
      const text = String(((block.text ?? {}) as Record<string, unknown>).content ?? "");
      return text ? { kind: "text", text } : null;
    }
    if (mask === "block.think") {
      const text = String(((block.think ?? {}) as Record<string, unknown>).content ?? "");
      return text ? { kind: "think", text } : null;
    }
  }
  return null;
}

/** Detect end-of-stream via MESSAGE_STATUS_COMPLETED on assistant role. */
export function isEndOfStream(msg: Record<string, unknown> | null): boolean {
  if (!msg) return false;
  const message = (msg.message ?? null) as Record<string, unknown> | null;
  if (
    message &&
    String(message.status ?? "") === "MESSAGE_STATUS_COMPLETED" &&
    String(message.role ?? "") === "assistant"
  ) {
    return true;
  }
  // Also detect via done:{} frame
  if (Object.prototype.hasOwnProperty.call(msg, "done")) return true;
  return false;
}

/** Extract chat.id from a Connect frame (for multi-turn registry). */
export function extractChatId(msg: Record<string, unknown> | null): string | null {
  if (!msg) return null;
  const chat = (msg.chat ?? null) as Record<string, unknown> | null;
  if (chat && typeof chat.id === "string") return chat.id;
  return null;
}

/** Extract chat.name from a Connect frame (auto-generated title for agent chats). */
export function extractChatName(msg: Record<string, unknown> | null): string | null {
  if (!msg) return null;
  const chat = (msg.chat ?? null) as Record<string, unknown> | null;
  if (chat && typeof chat.name === "string" && chat.name !== "Untitled Chat") return chat.name;
  return null;
}

// ── Search citations ───────────────────────────────────────────────────────

interface SearchChunk {
  id: string;
  base: {
    title: string;
    url: string;
    siteName?: string;
    snippet?: string;
    publishTime?: string;
  };
  refIndex: string;
}

/**
 * Extract search result chunks from message.refs.searchChunks frames.
 * Returns null if no search chunks are present.
 */
export function extractSearchChunks(msg: Record<string, unknown> | null): SearchChunk[] | null {
  if (!msg) return null;
  const message = (msg.message ?? null) as Record<string, unknown> | null;
  if (!message) return null;
  const refs = (message.refs ?? null) as Record<string, unknown> | null;
  if (!refs) return null;
  const chunks = refs.searchChunks;
  if (!Array.isArray(chunks) || chunks.length === 0) return null;
  return chunks as unknown as SearchChunk[];
}

/** Format search chunks as Markdown citations: [1]: [title](url) */
export function formatSearchCitations(chunks: SearchChunk[]): string {
  const lines: string[] = ["", "<!-- search-citations -->"];
  for (const chunk of chunks) {
    const title = chunk.base.title || "(untitled)";
    const url = chunk.base.url || "";
    const refIdx = chunk.refIndex || chunk.id;
    lines.push(`[${refIdx}]: [${title}](${url})`);
  }
  return lines.join("\n");
}

// ── Agent tool-call extraction ─────────────────────────────────────────────

interface AgentToolCall {
  blockId: string;
  toolCallId: string;
  argsBuffer: string;
  status: string;
  isError: boolean;
  errorCode?: string;
  contents: Array<Record<string, unknown>>;
  completed: boolean;
}

/**
 * Process a frame that may carry agent tool-call info (block.tool.*).
 * Returns updated tool-call state keyed by block.id.
 */
export function processAgentToolFrame(
  msg: Record<string, unknown> | null,
  toolCalls: Map<string, AgentToolCall>
): void {
  if (!msg) return;
  const op = String(msg.op ?? "");
  const mask = String(msg.mask ?? "");
  if (!mask.includes("tool")) return;

  const block = (msg.block ?? {}) as Record<string, unknown>;
  const blockId = String(block.id ?? "");
  if (!blockId) return;

  const tool = (block.tool ?? {}) as Record<string, unknown>;

  // Initial "set" with toolCallId + status:STATUS_RUNNING
  if (op === "set" && mask.includes("block.tool.args")) {
    const toolCallId = String(tool.toolCallId ?? "");
    const args = String(tool.args ?? "");
    const status = String(tool.status ?? "");
    if (toolCallId) {
      const existing = toolCalls.get(blockId);
      if (existing) {
        existing.argsBuffer = args;
        existing.toolCallId = toolCallId;
        existing.status = status;
      } else {
        toolCalls.set(blockId, {
          blockId,
          toolCallId,
          argsBuffer: args,
          status,
          isError: false,
          contents: [],
          completed: false,
        });
      }
    }
    return;
  }

  // Append to args (streaming fragments)
  if (op === "append" && mask === "block.tool.args") {
    const existing = toolCalls.get(blockId);
    if (existing) {
      existing.argsBuffer += String(tool.args ?? "");
    }
    return;
  }

  // Tool result (contents + status:STATUS_DONE)
  if (op === "set" && mask.includes("block.tool.contents")) {
    const existing = toolCalls.get(blockId);
    if (existing) {
      existing.status = String(tool.status ?? existing.status);
      existing.isError = Boolean(tool.isError);
      if (tool.errorCode) existing.errorCode = String(tool.errorCode);
      const contents = tool.contents;
      if (Array.isArray(contents)) {
        existing.contents = contents as Array<Record<string, unknown>>;
      }
      if (existing.status === "STATUS_DONE") existing.completed = true;
    } else {
      // New tool result without prior args (rare)
      toolCalls.set(blockId, {
        blockId,
        toolCallId: String(tool.toolCallId ?? ""),
        argsBuffer: "",
        status: String(tool.status ?? ""),
        isError: Boolean(tool.isError),
        errorCode: tool.errorCode ? String(tool.errorCode) : undefined,
        contents: Array.isArray(tool.contents)
          ? (tool.contents as Array<Record<string, unknown>>)
          : [],
        completed: String(tool.status ?? "") === "STATUS_DONE",
      });
    }
    return;
  }
}

/**
 * Convert completed agent tool calls into OpenAI tool_calls format.
 * Tool call IDs from Kimi look like "web_search:1", "web_search:2", etc.
 * We convert to a stable OpenAI-style id.
 */
export function agentToolCallsToOpenAI(toolCalls: Map<string, AgentToolCall>): Array<{
  id: string;
  type: string;
  function: { name: string; arguments: string };
}> {
  const result: Array<{ id: string; type: string; function: { name: string; arguments: string } }> =
    [];
  for (const [, tc] of toolCalls) {
    if (!tc.completed) continue;
    // Parse the toolCallId to determine tool name
    // Kimi uses "web_search:N" for web search, other tools may use different prefixes
    const colonIdx = tc.toolCallId.indexOf(":");
    const toolName = colonIdx > 0 ? tc.toolCallId.slice(0, colonIdx) : "kimi_tool";
    // argsBuffer is the JSON arguments string
    let args = tc.argsBuffer;
    if (!args) args = "{}";
    // For web_search, args look like {"queries": ["...", "..."]}
    // We wrap as the OpenAI function arguments
    result.push({
      id: `call_${tc.toolCallId.replace(/[^a-zA-Z0-9]/g, "_")}_${tc.blockId}`,
      type: "function",
      function: {
        name: toolName,
        arguments: args,
      },
    });
  }
  return result;
}

// ── Message folding ────────────────────────────────────────────────────────

function extractTextContent(content: OpenAIMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && p.type === "text" && p.text)
      .map((p) => p.text as string)
      .join("\n");
  }
  return "";
}

/**
 * Fold multi-turn OpenAI messages into a single Kimi user prompt.
 * System messages are prepended. Prior user/assistant turns are
 * concatenated with role labels for context.
 */
function foldMessages(messages: OpenAIMessage[]): string {
  let system = "";
  let user = "";
  for (const m of messages) {
    const text = extractTextContent(m.content);
    if (m.role === "system") {
      system += (system ? "\n\n" : "") + text;
    } else if (m.role === "user") {
      user = user ? `${user}\n\nUser: ${text}` : text;
    } else if (m.role === "assistant") {
      if (m.tool_calls && m.tool_calls.length > 0) {
        const callsStr = m.tool_calls
          .map((tc) => `${tc.function.name}(${tc.function.arguments})`)
          .join("\n");
        user = user
          ? `${user}\n\nAssistant: [Tool Calls]\n${callsStr}`
          : `Assistant: [Tool Calls]\n${callsStr}`;
      } else {
        user = user ? `${user}\n\nAssistant: ${text}` : `Assistant: ${text}`;
      }
    } else if (m.role === "tool") {
      user = user
        ? `${user}\n\n[Tool Result] (${m.tool_call_id}):\n${text}`
        : `[Tool Result] (${m.tool_call_id}):\n${text}`;
    }
  }
  return system ? `${system}\n\n${user}` : user;
}

// ── Image upload ───────────────────────────────────────────────────────────

interface KimiUploadedFile {
  fileId: string;
  name: string;
  size: number;
}

/**
 * Upload an image to Kimi's CDN (3-step process):
 *   1. POST /api/pre-sign-url with {action:"image", name, size} → get presigned URL + file_id + object_name
 *   2. PUT <presigned URL> with binary image bytes
 *   3. POST /api/file with {type:"image", name, size, file_id, object_name} → finalize
 *
 * Returns the file_id to use in the chat block: {file: {id: file_id}}
 */
async function uploadImageToKimi(
  jwt: string,
  imageBytes: Uint8Array,
  fileName: string,
  contentType: string
): Promise<KimiUploadedFile | null> {
  const headers = {
    Authorization: `Bearer ${jwt}`,
    "Content-Type": "application/json",
    Cookie: `kimi-auth=${jwt}`,
    Origin: BASE_URL,
    Referer: `${BASE_URL}/`,
    "User-Agent": USER_AGENT,
  };

  try {
    // Step 1: pre-sign-url
    const presignResp = await fetch(`${BASE_URL}/api/pre-sign-url`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "image", name: fileName, size: imageBytes.length }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!presignResp.ok) return null;
    const presignData = (await presignResp.json()) as {
      url: string;
      object_name: string;
      file_id: string;
    };
    if (!presignData.url || !presignData.file_id) return null;

    // Step 2: PUT to presigned URL
    const putResp = await fetch(presignData.url, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: imageBytes,
      signal: AbortSignal.timeout(60_000),
    });
    if (!putResp.ok) return null;

    // Step 3: finalize via /api/file
    const fileResp = await fetch(`${BASE_URL}/api/file`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "image",
        name: fileName,
        size: imageBytes.length,
        file_id: presignData.file_id,
        object_name: presignData.object_name,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!fileResp.ok) return null;
    const fileData = (await fileResp.json()) as { id?: string };
    if (!fileData.id) return null;

    return { fileId: fileData.id, name: fileName, size: imageBytes.length };
  } catch {
    return null;
  }
}

/** Extract image URLs from OpenAI messages content array. */
function extractImageUrlsFromMessages(
  messages: OpenAIMessage[]
): Array<{ url: string; name: string }> {
  const images: Array<{ url: string; name: string }> = [];
  for (const msg of messages) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type === "image_url" && part.image_url) {
        const url = typeof part.image_url === "string" ? part.image_url : part.image_url.url;
        if (url) images.push({ url, name: `image-${images.length}.png` });
      }
    }
  }
  return images;
}

/** Fetch image bytes from a URL or data: URI. */
async function fetchImageBytes(
  url: string
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  try {
    if (url.startsWith("data:")) {
      const match = url.match(/^data:([^;]+);base64,(.*)$/);
      if (!match) return null;
      return {
        bytes: new Uint8Array(Buffer.from(match[2], "base64")),
        contentType: match[1],
      };
    }
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const contentType = resp.headers.get("content-type") || "image/png";
    const buf = await resp.arrayBuffer();
    return { bytes: new Uint8Array(buf), contentType };
  } catch {
    return null;
  }
}

// ── Chat deletion ──────────────────────────────────────────────────────────

async function deleteKimiChat(jwt: string, chatId: string): Promise<boolean> {
  if (!chatId) return false;
  try {
    const resp = await fetch(DELETE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
        "connect-protocol-version": "1",
        Cookie: `kimi-auth=${jwt}`,
        Origin: BASE_URL,
        Referer: `${BASE_URL}/`,
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({ chat_id: chatId }),
      signal: AbortSignal.timeout(15_000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

// ── Early error detection & retry ──────────────────────────────────────────

/**
 * Read the first few frames from a Kimi Connect-RPC stream (the peek branch
 * of a tee) to detect errors before we commit to streaming the response to
 * the client. Kimi returns errors (resource_exhausted, paywall, auth) INSIDE
 * the stream on HTTP 200, so we must peek at the initial frames to catch them.
 *
 * Returns:
 *   - { error: KimiStreamError } if an error frame was detected
 *   - { ok: true } if no error was found in the first maxFramesToPeek frames
 *     (the main branch continues streaming to the client normally)
 */
async function peekForEarlyError(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxFramesToPeek = 10
): Promise<{ error: KimiStreamError } | { ok: true }> {
  let buffer = new Uint8Array(0);
  let frameCount = 0;

  while (frameCount < maxFramesToPeek) {
    const { done, value } = await reader.read();
    if (done) {
      // Stream ended — no error detected
      return { ok: true };
    }
    if (!value) continue;
    const merged = new Uint8Array(buffer.length + value.length);
    merged.set(buffer, 0);
    merged.set(value, buffer.length);
    buffer = merged;

    let offset = 0;
    while (offset < buffer.length) {
      const { consumed, frame } = decodeConnectFrame(buffer, offset);
      if (consumed === 0) break;
      if (consumed === -1) {
        // Protocol error — treat as fatal
        return {
          error: {
            kind: "fatal",
            code: "protocol_error",
            message: "Connect frame exceeded MAX_FRAME_LEN",
          },
        };
      }
      offset += consumed;
      if (!frame?.message) continue;
      frameCount++;

      // Check for error frame FIRST (before checking end-of-stream, since
      // Kimi may send done:{} followed by error:{} in the same stream)
      const streamError = extractStreamError(frame.message);
      if (streamError) {
        return { error: streamError };
      }

      // If we see actual content (text/think delta), we're past the error
      // window — no error. Return ok so the main branch continues streaming.
      const delta = extractDelta(frame.message);
      if (delta) {
        return { ok: true };
      }
    }
    buffer = buffer.subarray(offset);
  }

  // Peeking limit reached without content or error — assume ok
  return { ok: true };
}

/** Retry config for transient Kimi errors. */
const KIMI_RETRY_MAX_ATTEMPTS = 2;
const KIMI_RETRY_BASE_DELAY_MS = 2000;

/** Sleep helper that respects the abort signal. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        },
        { once: true }
      );
    }
  });
}

/**
 * Map a KimiStreamError to an HTTP status code + user-friendly message.
 *   - paywall   → 402 Payment Required
 *   - auth      → 401 Unauthorized
 *   - transient → 503 Service Unavailable (after retries exhausted)
 *   - fatal     → 502 Bad Gateway
 */
function kimiErrorToHttpStatus(err: KimiStreamError): { status: number; message: string } {
  switch (err.kind) {
    case "paywall":
      return {
        status: 402,
        message: `Kimi subscription required: ${err.message}. This feature (agent variants or high-traffic periods) needs a paid Kimi subscription. Upgrade at https://www.kimi.com`,
      };
    case "auth":
      return {
        status: 401,
        message: `Kimi session expired or invalid: ${err.message}. Re-login at https://www.kimi.com and paste a fresh Cookie header.`,
      };
    case "transient":
      return {
        status: 503,
        message: `Kimi server is temporarily overloaded: ${err.message}. Retried ${KIMI_RETRY_MAX_ATTEMPTS} times without success. Please try again later.`,
      };
    default:
      return {
        status: 502,
        message: `Kimi upstream error (${err.code}): ${err.message}`,
      };
  }
}

// ── Executor ───────────────────────────────────────────────────────────────

export class KimiWebExecutor extends BaseExecutor {
  constructor() {
    super("kimi-web", { id: "kimi-web", baseUrl: BASE_URL });
  }

  private buildKimiHeaders(
    jwt: string,
    customHeaders?: Record<string, string>
  ): Record<string, string> {
    const defaults: Record<string, string> = {
      "Content-Type": "application/connect+json",
      Accept: "*/*",
      "User-Agent": USER_AGENT,
      Origin: BASE_URL,
      Referer: `${BASE_URL}/`,
      "connect-protocol-version": "1",
      "x-msh-platform": "web",
      "x-msh-version": "1.0.0",
      "r-timezone": "Asia/Tehran",
      "x-language": "en-US",
    };
    if (jwt) {
      defaults["Authorization"] = `Bearer ${jwt}`;
      defaults["Cookie"] = `kimi-auth=${jwt}`;
    }
    return { ...defaults, ...(customHeaders || {}) };
  }

  private buildRequestBody(
    prompt: string,
    modelConfig: KimiModelConfig,
    wantThinking: boolean,
    chatId: string | null,
    wantWebSearch: boolean,
    fileBlocks: Array<{ file: { id: string } }>
  ): string {
    const blocks: Array<Record<string, unknown>> = [
      { message_id: "", text: { content: prompt } },
      ...fileBlocks,
    ];

    const body: Record<string, unknown> = {
      scenario: modelConfig.scenario,
      tools: wantWebSearch
        ? [{ type: "TOOL_TYPE_SEARCH", search: {} }, { type: "TOOL_TYPE_CRON_JOB" }]
        : [{ type: "TOOL_TYPE_CRON_JOB" }],
      message: {
        role: "user",
        blocks,
        scenario: modelConfig.scenario,
        is_goal: false,
      },
      options: { thinking: wantThinking, enable_plugin: true },
      project_id: "",
    };

    // Agent variants need kimiPlusId + agentMode
    if (modelConfig.kimiPlusId) body.kimiPlusId = modelConfig.kimiPlusId;
    if (modelConfig.agentMode) body.agentMode = modelConfig.agentMode;

    // Multi-turn: pass chat_id to continue existing conversation
    if (chatId) body.chat_id = chatId;

    return JSON.stringify(body);
  }

  override async execute(input: ExecuteInput): Promise<{
    response: Response;
    url: string;
    headers: Record<string, string>;
    transformedBody: unknown;
  }> {
    const { body, credentials, signal, stream: wantStream, log } = input;
    const bodyObj = (body || {}) as Record<string, unknown>;

    // 1. Extract JWT
    const rawCredential = String(credentials?.apiKey ?? "").trim();
    const jwt = extractKimiJwt(rawCredential);
    if (!jwt) {
      return makeErrorResult(
        400,
        "Missing Kimi session — paste the full Cookie header from www.kimi.com (must contain kimi-auth=<JWT>) or just the JWT itself.",
        body,
        CHAT_URL
      );
    }

    const customHeaders = (
      credentials?.providerSpecificData as { customHeaders?: Record<string, string> } | undefined
    )?.customHeaders;

    // 2. Resolve conversationId via providerSessionRegistry
    //    Kimi's chat.id is server-generated: first turn has no chat_id in request,
    //    we capture it from the response and save to registry. Subsequent turns
    //    pass chat_id in the request body.
    const connectionId = (credentials as { connectionId?: string })?.connectionId || "default";
    const agentChatId = getAgentChatId(bodyObj, input.clientHeaders as Record<string, unknown>);

    let existingChatId: string | null = null;
    if (agentChatId) {
      const existing = getMapping({ connectionId, agentChatId, provider: "kimi" });
      if (existing) {
        existingChatId = existing.providerConversationId;
        log?.debug?.(
          "KIMI-WEB",
          `registry: agentChatId=${agentChatId.slice(0, 16)} -> chatId=${existingChatId.slice(0, 16)} (reused)`
        );
      } else {
        log?.debug?.(
          "KIMI-WEB",
          `registry: agentChatId=${agentChatId.slice(0, 16)} -> new chat (will capture id)`
        );
      }
    }

    // 3. Prepare messages with tool support (OmniRoute native webTools.ts)
    //    Strip built-in web_search tools first — they are handled natively
    //    by Kimi's TOOL_TYPE_SEARCH, not as function-calling tools.
    const messages = (bodyObj.messages as OpenAIMessage[]) || [];
    const clientWantsWebSearchRaw = hasNativeWebSearchTool(bodyObj);
    if (clientWantsWebSearchRaw && Array.isArray(bodyObj.tools)) {
      bodyObj.tools = bodyObj.tools.filter((t: unknown) => {
        if (!t || typeof t !== "object") return true;
        const rec = t as Record<string, unknown>;
        const tt = typeof rec.type === "string" ? rec.type : "";
        return tt !== "web_search" && tt !== "web_search_preview";
      });
      if (Array.isArray(bodyObj.tools) && bodyObj.tools.length === 0) {
        delete bodyObj.tools;
      }
    }
    const { hasTools, requestedTools, effectiveMessages } = prepareToolMessages(bodyObj, messages);
    const prompt = foldMessages(effectiveMessages as OpenAIMessage[]);

    // 4. Resolve model + thinking
    const modelId = (bodyObj.model as string) || "k2d6";
    const modelConfig = resolveModelConfig(modelId);
    const wantThinking = bodyObj.reasoning_effort === "none" ? false : modelConfig.thinking;

    // 5. Resolve think mode
    const thinkMode = resolveThinkMode({
      headers: input.clientHeaders as Record<string, unknown>,
      body: bodyObj,
      providerSpecificData: credentials?.providerSpecificData as Record<string, unknown> | null,
    });

    // 6. Web search: enable when client sends web_search tool OR when using agent variants
    //    (agent variants have built-in web search capability)
    const clientWantsWebSearch = clientWantsWebSearchRaw || hasNativeWebSearchTool(bodyObj);
    const wantWebSearch = clientWantsWebSearch || modelConfig.kimiPlusId !== undefined;

    // 7. Upload images if present
    const fileBlocks: Array<{ file: { id: string } }> = [];
    const imageUrls = extractImageUrlsFromMessages(messages);
    if (imageUrls.length > 0) {
      log?.debug?.("KIMI-WEB", `Uploading ${imageUrls.length} images to Kimi CDN`);
      for (const img of imageUrls) {
        const imgData = await fetchImageBytes(img.url);
        if (!imgData) continue;
        const uploaded = await uploadImageToKimi(jwt, imgData.bytes, img.name, imgData.contentType);
        if (uploaded) {
          fileBlocks.push({ file: { id: uploaded.fileId } });
          log?.debug?.("KIMI-WEB", `Uploaded image: ${uploaded.fileId}`);
        }
      }
    }

    // 8. Build request
    const reqBody = this.buildRequestBody(
      prompt,
      modelConfig,
      wantThinking,
      existingChatId,
      wantWebSearch,
      fileBlocks
    );
    const reqHeaders = this.buildKimiHeaders(jwt, customHeaders);
    const framedBody = frameConnectMessage(reqBody);

    // 9. Send chat request with retry on transient errors.
    //    Kimi returns errors INSIDE the Connect-RPC stream (HTTP 200), so we
    //    peek at the first few frames to detect errors before committing to
    //    streaming the response to the client. Transient errors (server overload)
    //    are retried with exponential backoff; paywall/auth/fatal errors are
    //    surfaced immediately.
    let upstream: Response;
    let peekedStream: ReadableStream<Uint8Array> | null = null;
    let attempt = 0;

    while (true) {
      attempt++;
      try {
        upstream = await fetch(CHAT_URL, {
          method: "POST",
          headers: reqHeaders,
          body: new Uint8Array(framedBody),
          signal,
        });
      } catch (err) {
        if (attempt <= KIMI_RETRY_MAX_ATTEMPTS && !signal?.aborted) {
          const delay = KIMI_RETRY_BASE_DELAY_MS * attempt;
          log?.warn?.(
            "KIMI-WEB",
            `fetch failed (attempt ${attempt}/${KIMI_RETRY_MAX_ATTEMPTS}), retrying in ${delay}ms: ${err instanceof Error ? err.message : "unknown"}`
          );
          try {
            await sleep(delay, signal);
          } catch {
            /* aborted */
          }
          continue;
        }
        return makeErrorResult(
          502,
          `Kimi fetch failed: ${err instanceof Error ? err.message : "unknown"}`,
          body,
          CHAT_URL
        );
      }

      if (!upstream.ok) {
        // HTTP-level error — retry on 429/503, otherwise surface
        if (
          (upstream.status === 429 || upstream.status === 503) &&
          attempt <= KIMI_RETRY_MAX_ATTEMPTS &&
          !signal?.aborted
        ) {
          const delay = KIMI_RETRY_BASE_DELAY_MS * attempt;
          log?.warn?.(
            "KIMI-WEB",
            `HTTP ${upstream.status} (attempt ${attempt}/${KIMI_RETRY_MAX_ATTEMPTS}), retrying in ${delay}ms`
          );
          try {
            await sleep(delay, signal);
          } catch {
            /* aborted */
          }
          continue;
        }
        const errText = await upstream.text().catch(() => "");
        return makeErrorResult(
          upstream.status,
          `Kimi error: ${sanitizeErrorMessage(errText)}`,
          body,
          CHAT_URL
        );
      }

      // HTTP 200 — peek at the first few stream frames to detect in-stream errors.
      // We tee the stream so the peek doesn't consume the bytes — the main
      // branch continues streaming to the client without losing any deltas.
      const rawBody = upstream.body ?? new ReadableStream({ start: (c) => c.close() });
      const [peekBranch, mainBranch] = rawBody.tee();
      const peekReader = peekBranch.getReader();
      const peekResult = await peekForEarlyError(peekReader);

      if ("error" in peekResult) {
        const streamError = peekResult.error;
        log?.warn?.(
          "KIMI-WEB",
          `stream error (attempt ${attempt}/${KIMI_RETRY_MAX_ATTEMPTS}): kind=${streamError.kind} code=${streamError.code} reason=${streamError.reason || "(none)"}`
        );

        // Retry only transient errors
        if (
          streamError.kind === "transient" &&
          attempt <= KIMI_RETRY_MAX_ATTEMPTS &&
          !signal?.aborted
        ) {
          const delay = KIMI_RETRY_BASE_DELAY_MS * attempt;
          log?.warn?.("KIMI-WEB", `retrying in ${delay}ms due to transient error`);
          try {
            await sleep(delay, signal);
          } catch {
            /* aborted */
          }
          continue;
        }

        // Non-retryable or retries exhausted — surface clear error to client
        const { status, message } = kimiErrorToHttpStatus(streamError);
        return makeErrorResult(status, message, body, CHAT_URL);
      }

      // No error detected — use the main branch (untouched stream)
      peekedStream = mainBranch;
      break;
    }

    // 10. Process response
    const id = `chatcmpl-kimi-${Date.now().toString(36)}`;
    const created = Math.floor(Date.now() / 1000);
    const sourceStream =
      peekedStream ?? upstream.body ?? new ReadableStream({ start: (c) => c.close() });

    const persistSession =
      (credentials?.providerSpecificData as { persistSession?: boolean } | undefined)
        ?.persistSession === true;
    // Aligned with deepseek-web #2942: delete chat after response unless persistSession=true
    const shouldDeleteAfter = !persistSession;

    const doCleanup = async (capturedChatId: string | null) => {
      try {
        if (shouldDeleteAfter && capturedChatId) {
          await deleteKimiChat(jwt, capturedChatId);
        }
      } catch {
        /* best-effort */
      }
    };

    // Helper to save chat.id to registry when captured
    const saveChatIdToRegistry = (chatId: string) => {
      if (agentChatId && chatId && !existingChatId) {
        saveMapping({
          connectionId,
          agentChatId,
          provider: "kimi",
          providerConversationId: chatId,
        });
        log?.debug?.(
          "KIMI-WEB",
          `registry: saved agentChatId=${agentChatId.slice(0, 16)} -> chatId=${chatId.slice(0, 16)}`
        );
      }
    };

    const encoder = new TextEncoder();

    const emitChunk = (
      controller: ReadableStreamDefaultController,
      delta: Record<string, unknown>,
      finish: string | null = null
    ) => {
      const chunk = {
        id,
        object: "chat.completion.chunk",
        created,
        model: modelId,
        choices: [{ index: 0, delta, finish_reason: finish }],
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
    };

    const sourceReader = sourceStream.getReader();

    if (wantStream) {
      // Tool mode: buffer full response, then emit as synthetic SSE
      if (hasTools) {
        let totalContent = "";
        let totalReasoning = "";
        let capturedChatId: string | null = existingChatId;
        let buffer = new Uint8Array(0);

        try {
          while (true) {
            const { done, value } = await sourceReader.read();
            if (done) break;
            if (!value) continue;
            const merged = new Uint8Array(buffer.length + value.length);
            merged.set(buffer, 0);
            merged.set(value, buffer.length);
            buffer = merged;
            let offset = 0;
            while (offset < buffer.length) {
              const { consumed, frame } = decodeConnectFrame(buffer, offset);
              if (consumed === -1) break;
              if (consumed === 0) break;
              offset += consumed;
              if (!frame?.message) continue;
              const msg = frame.message;
              const chatId = extractChatId(msg);
              if (chatId) capturedChatId = chatId;
              const delta = extractDelta(msg);
              if (delta) {
                if (delta.kind === "think") totalReasoning += delta.text;
                else totalContent += delta.text;
              }
            }
            buffer = buffer.subarray(offset);
          }
        } catch {
          /* best-effort */
        }

        // Save chat.id to registry
        if (capturedChatId) saveChatIdToRegistry(capturedChatId);

        const { content: cleanedContent, reasoning } = applyThinkMode(totalContent, thinkMode);
        const message: Record<string, unknown> = { role: "assistant", content: cleanedContent };
        if (reasoning) message.reasoning_content = reasoning;

        const completion = {
          id,
          object: "chat.completion",
          created,
          model: modelId,
          choices: [{ index: 0, message, finish_reason: "stop" }],
        };
        const bufferedResponse = new Response(JSON.stringify(completion), {
          headers: { "Content-Type": "application/json" },
        });
        const toolResponse = await buildToolModeResponse(bufferedResponse, requestedTools, true, {
          cid: id,
          created,
          model: modelId,
          idSeed: "kimi",
        });

        await doCleanup(capturedChatId).catch(() => {});
        return {
          response: toolResponse,
          url: CHAT_URL,
          headers: reqHeaders,
          transformedBody: JSON.parse(reqBody),
        };
      }

      // Normal streaming
      const outStream = new ReadableStream({
        async start(controller) {
          let buffer = new Uint8Array(0);
          let emittedRole = false;
          let totalContent = "";
          let capturedChatId: string | null = existingChatId;
          const thinkCtx = createThinkStreamContext(thinkMode);
          const agentToolCalls = new Map<string, AgentToolCall>();
          let allSearchChunks: SearchChunk[] = [];
          let bufferFlushed = false;

          try {
            while (true) {
              const { done, value } = await sourceReader.read();
              if (done) break;
              if (!value) continue;
              const merged = new Uint8Array(buffer.length + value.length);
              merged.set(buffer, 0);
              merged.set(value, buffer.length);
              buffer = merged;
              let offset = 0;
              while (offset < buffer.length) {
                const { consumed, frame } = decodeConnectFrame(buffer, offset);
                if (consumed === -1) {
                  controller.error(new Error("Kimi Connect frame exceeded MAX_FRAME_LEN"));
                  return;
                }
                if (consumed === 0) break;
                offset += consumed;
                if (!frame?.message) continue;

                const msg = frame.message;
                const chatId = extractChatId(msg);
                if (chatId) capturedChatId = chatId;

                // Capture search chunks
                const chunks = extractSearchChunks(msg);
                if (chunks) allSearchChunks = chunks;

                // Process agent tool-call frames
                processAgentToolFrame(msg, agentToolCalls);

                const delta = extractDelta(msg);
                if (delta) {
                  if (!emittedRole) {
                    emittedRole = true;
                    emitChunk(controller, { role: "assistant", content: "" });
                  }
                  if (delta.kind === "think") {
                    const { reasoningDelta } = processThinkStreamDelta(delta.text, thinkCtx);
                    if (reasoningDelta)
                      emitChunk(controller, { reasoning_content: reasoningDelta });
                  } else {
                    totalContent += delta.text;
                    const { contentDelta } = processThinkStreamDelta(delta.text, thinkCtx);
                    if (contentDelta) emitChunk(controller, { content: contentDelta });
                  }
                }

                if (isEndOfStream(msg)) {
                  // Flush think content
                  if (!bufferFlushed) {
                    bufferFlushed = true;
                    const flushed = flushThinkStream(thinkCtx);
                    if (flushed.reasoningDelta)
                      emitChunk(controller, { reasoning_content: flushed.reasoningDelta });
                    if (flushed.contentDelta)
                      emitChunk(controller, { content: flushed.contentDelta });
                  }

                  // Append search citations to content if any
                  if (allSearchChunks.length > 0) {
                    const citations = formatSearchCitations(allSearchChunks);
                    if (citations) emitChunk(controller, { content: citations });
                  }

                  // Emit agent tool calls if any
                  const openaiToolCalls = agentToolCallsToOpenAI(agentToolCalls);
                  if (openaiToolCalls.length > 0) {
                    for (const tc of openaiToolCalls) {
                      emitChunk(controller, { tool_calls: [tc] });
                    }
                    emitChunk(controller, {}, "tool_calls");
                  } else {
                    emitChunk(controller, {}, "stop");
                  }

                  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                  // Save chat.id before closing
                  if (capturedChatId) saveChatIdToRegistry(capturedChatId);
                  try {
                    await doCleanup(capturedChatId);
                  } catch {
                    /* best-effort */
                  }
                  controller.close();
                  return;
                }
              }
              buffer = buffer.subarray(offset);
            }

            // Stream ended without explicit end marker
            if (!emittedRole) emitChunk(controller, { role: "assistant", content: "" });
            if (!bufferFlushed) {
              const flushed = flushThinkStream(thinkCtx);
              if (flushed.reasoningDelta)
                emitChunk(controller, { reasoning_content: flushed.reasoningDelta });
              if (flushed.contentDelta) emitChunk(controller, { content: flushed.contentDelta });
            }
            if (allSearchChunks.length > 0) {
              const citations = formatSearchCitations(allSearchChunks);
              if (citations) emitChunk(controller, { content: citations });
            }
            const openaiToolCalls = agentToolCallsToOpenAI(agentToolCalls);
            const finishReason = openaiToolCalls.length > 0 ? "tool_calls" : "stop";
            if (openaiToolCalls.length > 0) {
              for (const tc of openaiToolCalls) emitChunk(controller, { tool_calls: [tc] });
            }
            emitChunk(controller, {}, finishReason);
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            if (capturedChatId) saveChatIdToRegistry(capturedChatId);
            try {
              await doCleanup(capturedChatId);
            } catch {
              /* best-effort */
            }
            controller.close();
          } catch (err) {
            if (!signal?.aborted) {
              try {
                controller.error(err);
              } catch {
                /* closed */
              }
            }
          }
        },
      });

      return {
        response: new Response(outStream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        }),
        url: CHAT_URL,
        headers: reqHeaders,
        transformedBody: JSON.parse(reqBody),
      };
    }

    // Non-streaming: collect full response
    let totalContent = "";
    let totalReasoning = "";
    let capturedChatId: string | null = existingChatId;
    let buffer = new Uint8Array(0);
    const agentToolCalls = new Map<string, AgentToolCall>();
    let allSearchChunks: SearchChunk[] = [];

    try {
      while (true) {
        const { done, value } = await sourceReader.read();
        if (done) break;
        if (!value) continue;
        const merged = new Uint8Array(buffer.length + value.length);
        merged.set(buffer, 0);
        merged.set(value, buffer.length);
        buffer = merged;
        let offset = 0;
        while (offset < buffer.length) {
          const { consumed, frame } = decodeConnectFrame(buffer, offset);
          if (consumed === -1) break;
          if (consumed === 0) break;
          offset += consumed;
          if (!frame?.message) continue;
          const msg = frame.message;
          const chatId = extractChatId(msg);
          if (chatId) capturedChatId = chatId;
          const chunks = extractSearchChunks(msg);
          if (chunks) allSearchChunks = chunks;
          processAgentToolFrame(msg, agentToolCalls);
          const delta = extractDelta(msg);
          if (delta) {
            if (delta.kind === "think") totalReasoning += delta.text;
            else totalContent += delta.text;
          }
          if (isEndOfStream(msg)) {
            offset = buffer.length;
            break;
          }
        }
        buffer = buffer.subarray(offset);
      }
    } catch {
      /* best-effort */
    }

    // Save chat.id to registry
    if (capturedChatId) saveChatIdToRegistry(capturedChatId);

    // Apply think mode
    const { content: contentAfterThink, reasoning } = applyThinkMode(totalContent, thinkMode);
    let finalContent = contentAfterThink;
    const finalThinking = reasoning ? (reasoning.trim() ? reasoning : null) : null;

    // Append search citations
    if (allSearchChunks.length > 0) {
      finalContent += formatSearchCitations(allSearchChunks);
    }

    // Parse tool calls (function tools via webTools.ts)
    let toolCalls: ReturnType<typeof buildToolAwareResult>["toolCalls"] = null;
    let finishReason = "stop";
    if (hasTools) {
      const result = buildToolAwareResult(finalContent, requestedTools, "kimi");
      toolCalls = result.toolCalls;
      finishReason = result.finishReason;
    }

    // Also check agent tool calls (from agent variants)
    const agentToolCallsOpenAI = agentToolCallsToOpenAI(agentToolCalls);
    if (agentToolCallsOpenAI.length > 0) {
      toolCalls = agentToolCallsOpenAI;
      finishReason = "tool_calls";
    }

    const message: Record<string, unknown> = {
      role: "assistant",
      content: toolCalls ? null : finalContent,
    };
    if (finalThinking) message.reasoning_content = finalThinking;
    if (toolCalls) message.tool_calls = toolCalls;

    const completion = {
      id,
      object: "chat.completion",
      created,
      model: modelId,
      choices: [{ index: 0, message, finish_reason: finishReason }],
    };

    await doCleanup(capturedChatId).catch(() => {});
    log?.debug?.(
      "KIMI-WEB",
      `completed chatId=${capturedChatId?.slice(0, 16) || "(none)"} contentLen=${finalContent.length}`
    );

    return {
      response: new Response(JSON.stringify(completion), {
        headers: { "Content-Type": "application/json" },
      }),
      url: CHAT_URL,
      headers: reqHeaders,
      transformedBody: JSON.parse(reqBody),
    };
  }
}

export default KimiWebExecutor;
