/**
 * Think Mode Processor — Unified reasoning content handler.
 *
 * Modes:
 *   separate (default): <think> → reasoning_content, stripped from content
 *   passthrough: <think> tags left inline in content
 *   strip: think content discarded entirely
 *
 * @module utils/thinkModeProcessor
 */

export type ThinkMode = "passthrough" | "strip" | "separate";

export interface ThinkProcessResult {
  content: string;
  reasoning: string | null;
}

export interface ThinkStreamDelta {
  contentDelta: string | null;
  reasoningDelta: string | null;
}

export interface ThinkStreamContext {
  mode: ThinkMode;
  insideThink: boolean;
  buffer: string;
  currentTag: string | null;
}

const REASONING_TAG_NAMES = ["think", "thinking", "thought", "internal_thought"] as const;

export function normalizeThinkMode(value: unknown): ThinkMode {
  if (value === "passthrough" || value === "strip" || value === "separate") return value;
  return "separate";
}

export function hasThinkTags(text: string): boolean {
  if (!text || typeof text !== "string") return false;
  for (const tagName of REASONING_TAG_NAMES) {
    if (text.includes(`<${tagName}`)) return true;
  }
  return false;
}

// ── Batch ──────────────────────────────────────────────────────────────────

export function applyThinkMode(text: string, mode: ThinkMode = "separate"): ThinkProcessResult {
  if (!text || typeof text !== "string") return { content: text || "", reasoning: null };
  if (mode === "passthrough") return { content: text, reasoning: null };

  let cleaned = text.replace(/\u0000/g, "");
  const thinkingParts: string[] = [];
  let hasThinkTags = false;

  // Standard blocks: <think>...</think> etc.
  const blockRe = new RegExp(
    `<(${REASONING_TAG_NAMES.join("|")})\\b[^>]*>([\\s\\S]*?)<\\/\\1>`,
    "gi"
  );
  cleaned = cleaned.replace(blockRe, (_m, _tag, thinkContent) => {
    hasThinkTags = true;
    const trimmed = thinkContent.trim();
    if (trimmed) thinkingParts.push(trimmed);
    return "";
  });

  // MiMo </thinkgt; typo variant
  const thinkgtRe = /<think[^>]*>([\s\S]*?)<\/thinkgt>/g;
  cleaned = cleaned.replace(thinkgtRe, (_m, thinkContent) => {
    hasThinkTags = true;
    const trimmed = thinkContent.trim();
    if (trimmed) thinkingParts.push(trimmed);
    return "";
  });

  // Unclosed tag at end
  const unclosedRe = new RegExp(
    `<(${REASONING_TAG_NAMES.join("|")})(?:\\s[^>]*)?(?:>|\\r?\\n)([\\s\\S]*)$`,
    "i"
  );
  const unclosedMatch = cleaned.match(unclosedRe);
  if (unclosedMatch?.index !== undefined) {
    hasThinkTags = true;
    const reasoning = String(unclosedMatch[2] || "").trim();
    if (reasoning) thinkingParts.push(reasoning);
    const prefix = cleaned.slice(0, unclosedMatch.index);
    cleaned = /^(?:\s)*$/.test(prefix) ? "" : prefix;
  }

  if (!hasThinkTags) return { content: text, reasoning: null };

  if (mode === "strip") return { content: cleaned.trim(), reasoning: null };

  return {
    content: cleaned.trim(),
    reasoning: thinkingParts.length > 0 ? thinkingParts.join("\n\n") : null,
  };
}

// ── Streaming ──────────────────────────────────────────────────────────────

export function createThinkStreamContext(mode: ThinkMode = "separate"): ThinkStreamContext {
  return { mode, insideThink: false, buffer: "", currentTag: null };
}

export function processThinkStreamDelta(delta: string, ctx: ThinkStreamContext): ThinkStreamDelta {
  if (!delta) return { contentDelta: null, reasoningDelta: null };
  if (ctx.mode === "passthrough") return { contentDelta: delta, reasoningDelta: null };

  const cleaned = delta.replace(/\u0000/g, "");
  if (!cleaned) return { contentDelta: null, reasoningDelta: null };

  ctx.buffer += cleaned;
  let contentDelta = "";
  let reasoningDelta = "";

  let safety = 0;
  while (ctx.buffer.length > 0 && safety < 1000) {
    safety++;

    if (ctx.insideThink && ctx.currentTag) {
      const closeTag = `</${ctx.currentTag}`;
      const closeIdx = ctx.buffer.indexOf(closeTag);

      if (closeIdx === -1) {
        const safeLen = ctx.buffer.length - closeTag.length;
        if (safeLen > 0) {
          if (ctx.mode === "separate") reasoningDelta += ctx.buffer.slice(0, safeLen);
          ctx.buffer = ctx.buffer.slice(safeLen);
        }
        break;
      }

      const reasoning = ctx.buffer.slice(0, closeIdx);
      if (reasoning && ctx.mode === "separate") reasoningDelta += reasoning;

      const closeEnd = ctx.buffer.indexOf(">", closeIdx + closeTag.length);
      if (closeEnd === -1) {
        ctx.buffer = ctx.buffer.slice(closeIdx);
        break;
      }
      ctx.buffer = ctx.buffer.slice(closeEnd + 1);
      ctx.insideThink = false;
      ctx.currentTag = null;
    } else {
      const openRe = new RegExp(`<(${REASONING_TAG_NAMES.join("|")})\\b[^>]*>`, "i");
      const openMatch = ctx.buffer.match(openRe);

      if (!openMatch || openMatch.index === undefined) {
        const maxTagLen = 20;
        if (ctx.buffer.length > maxTagLen) {
          contentDelta += ctx.buffer.slice(0, -maxTagLen);
          ctx.buffer = ctx.buffer.slice(-maxTagLen);
        }
        break;
      }

      const before = ctx.buffer.slice(0, openMatch.index);
      if (before) contentDelta += before;

      ctx.currentTag = openMatch[1].toLowerCase();
      ctx.insideThink = true;

      const openEnd = openMatch.index + openMatch[0].length;
      ctx.buffer = ctx.buffer.slice(openEnd);
    }
  }

  return {
    contentDelta: contentDelta || null,
    reasoningDelta: reasoningDelta || null,
  };
}

export function flushThinkStream(ctx: ThinkStreamContext): ThinkStreamDelta {
  if (!ctx.buffer) return { contentDelta: null, reasoningDelta: null };
  const remaining = ctx.buffer;
  ctx.buffer = "";
  if (ctx.insideThink) {
    if (ctx.mode === "separate") return { contentDelta: null, reasoningDelta: remaining || null };
    return { contentDelta: null, reasoningDelta: null };
  }
  return { contentDelta: remaining || null, reasoningDelta: null };
}
