/**
 * Stateful parser for Z.AI's <details> reasoning blocks.
 *
 * Z.AI wraps reasoning content in <details ...>...</details> HTML tags INSIDE
 * the regular content stream. When the model emits reasoning, the upstream
 * sends text like:
 *
 *   <details open="true">
 *   > The user is asking about my identity...
 *   > I should emphasize how this training supports tasks...
 *   </details>
 *
 *   Final answer here.
 *
 * This parser splits the stream into:
 *   - `content`: the non-reasoning portion (e.g. "Final answer here.")
 *   - `reasoning`: the cleaned reasoning (without <details> tags or "> " prefixes)
 *
 * STATE MACHINE
 * ─────────────
 * The parser maintains a `phase` field that survives across chunks:
 *   - "content"   — currently accumulating normal content
 *   - "tag-open"  — saw `<details` but the opening `>` hasn't arrived yet
 *                   (the tag may be split across chunks, e.g. `<det` + `ails>`)
 *   - "reasoning" — saw the full `<details ...>` opening tag, accumulating
 *                   reasoning text until `</details>` arrives
 *
 * EDGE CASES HANDLED
 * ──────────────────
 *   - Tag split across chunks: `<det` then `ails open="true">`
 *   - Attribute value split:   `<details open="` then `true">`
 *   - Reasoning split:         `> Reasoning line 1\n` then `> Reasoning line 2\n`
 *   - Close tag split:         `</detail` then `s>`
 *   - Multiple <details> blocks in one stream
 *   - <details> with no </details> (incomplete stream — flush as reasoning)
 *   - Content BEFORE <details> (normal answer prefix)
 *   - Content AFTER </details> (final answer)
 *
 * This is the FIXED version of the original parser in zai-web-free.ts which
 * had a state-leak bug: after seeing `<details>`, it reassigned
 * `fullContent = content` (stripping the marker), so the NEXT chunk arrived
 * with no `<details` in `raw` and the parser forgot it was inside reasoning.
 */

export type DetailsParserPhase = "content" | "tag-open" | "reasoning";

export interface DetailsParserState {
  /** Current phase — survives across chunks. */
  phase: DetailsParserPhase;
  /** Buffered text waiting for more chunks (e.g. partial `<det`). */
  pendingTag: string;
  /** Accumulated reasoning text (cleaned of "> " prefixes lazily). */
  reasoningBuffer: string;
  /** Already-emitted content length (for delta computation). */
  sentContentLength: number;
  /** Already-emitted reasoning length (for delta computation). */
  sentReasoningLength: number;
}

export interface DetailsParserResult {
  /** New content delta to emit (empty string if none). */
  contentDelta: string;
  /** New reasoning delta to emit (empty string if none). */
  reasoningDelta: string;
}

/**
 * Create a fresh parser instance. Use one per stream.
 */
export function createDetailsParser(): {
  push: (chunk: string, thinkMode?: "separate" | "strip" | "passthrough") => DetailsParserResult;
  flush: (thinkMode?: "separate" | "strip" | "passthrough") => DetailsParserResult;
  getState: () => DetailsParserState;
} {
  const state: DetailsParserState = {
    phase: "content",
    pendingTag: "",
    reasoningBuffer: "",
    sentContentLength: 0,
    sentReasoningLength: 0,
  };

  /**
   * Clean a reasoning chunk: strip leading "> " from each line.
   * Z.AI prefixes reasoning lines with "> " so they render as blockquotes
   * in HTML; we strip them so the reasoning_content field is clean text.
   */
  function cleanReasoning(text: string): string {
    return text
      .split("\n")
      .map((line) => line.replace(/^> /, ""))
      .join("\n");
  }

  /**
   * Emit any accumulated content/reasoning as deltas.
   */
  function emitDeltas(
    newContentLength: number,
    newReasoningLength: number,
    thinkMode: "separate" | "strip" | "passthrough" = "separate"
  ): DetailsParserResult {
    let contentDelta = "";
    let reasoningDelta = "";

    if (newContentLength > state.sentContentLength) {
      // Caller is responsible for tracking the actual content string; we
      // only track lengths here. The wrapper below keeps a contentBuffer.
      // (This helper is not used directly — see push() below.)
    }
    return { contentDelta, reasoningDelta };
  }

  // We track the actual buffers here (not just lengths) because we need to
  // slice deltas out of them.
  let contentBuffer = "";
  let reasoningCleaned = ""; // cleaned reasoning (without "> " prefixes)

  function push(
    chunk: string,
    thinkMode: "separate" | "strip" | "passthrough" = "separate"
  ): DetailsParserResult {
    let contentDelta = "";
    let reasoningDelta = "";

    // Append the new chunk to wherever we currently are.
    if (state.phase === "content") {
      // Look for the start of a <details> tag.
      let cursor = 0;
      while (cursor < chunk.length) {
        const rest = chunk.slice(cursor);
        const detailsIdx = rest.indexOf("<details");

        if (detailsIdx === -1) {
          // No <details in the rest — but check if the END of the chunk
          // could be the start of a `<details` tag (partial match).
          const partialMatch = findPartialTagStart(rest);
          if (partialMatch > 0) {
            // Emit content before the partial tag, buffer the partial.
            const before = rest.slice(0, rest.length - partialMatch);
            if (before) {
              contentBuffer += before;
              contentDelta += before;
            }
            state.pendingTag = rest.slice(rest.length - partialMatch);
            state.phase = "tag-open";
            return { contentDelta, reasoningDelta };
          }
          // No partial tag — emit all as content.
          contentBuffer += rest;
          contentDelta += rest;
          state.sentContentLength = contentBuffer.length;
          return { contentDelta, reasoningDelta };
        }

        // Emit content before <details.
        const before = rest.slice(0, detailsIdx);
        if (before) {
          contentBuffer += before;
          contentDelta += before;
        }

        // Look for the closing > of the opening tag.
        const tagRest = rest.slice(detailsIdx);
        const tagEnd = tagRest.indexOf(">");
        if (tagEnd === -1) {
          // Opening tag not yet complete — buffer and switch phase.
          state.pendingTag = tagRest;
          state.phase = "tag-open";
          state.sentContentLength = contentBuffer.length;
          return { contentDelta, reasoningDelta };
        }

        // Opening tag complete — switch to reasoning phase.
        // Skip past the `>`.
        const afterTag = tagRest.slice(tagEnd + 1);
        state.phase = "reasoning";
        state.reasoningBuffer = "";
        cursor = 0;
        // Recurse into the afterTag portion with the new phase.
        // We do this by treating afterTag as a new chunk in reasoning phase.
        const sub = pushReasoning(afterTag, thinkMode);
        reasoningDelta += sub.reasoningDelta;
        contentDelta += sub.contentDelta;
        // After pushReasoning, phase may have flipped back to "content"
        // if it saw </details>. Continue the outer loop with the rest.
        // But pushReasoning already consumed everything, so we break.
        break;
      }

      state.sentContentLength = contentBuffer.length;
      return { contentDelta, reasoningDelta };
    }

    if (state.phase === "tag-open") {
      // We have a partial `<details...` tag. Append chunk and try again.
      const combined = state.pendingTag + chunk;
      const tagEnd = combined.indexOf(">");
      if (tagEnd === -1) {
        // Still incomplete — keep buffering.
        state.pendingTag = combined;
        return { contentDelta, reasoningDelta };
      }
      // Tag complete — switch to reasoning.
      const afterTag = combined.slice(tagEnd + 1);
      state.phase = "reasoning";
      state.reasoningBuffer = "";
      state.pendingTag = "";
      const sub = pushReasoning(afterTag, thinkMode);
      reasoningDelta += sub.reasoningDelta;
      contentDelta += sub.contentDelta;
      state.sentContentLength = contentBuffer.length;
      return { contentDelta, reasoningDelta };
    }

    // phase === "reasoning"
    const sub = pushReasoning(chunk, thinkMode);
    reasoningDelta += sub.reasoningDelta;
    contentDelta += sub.contentDelta;
    state.sentContentLength = contentBuffer.length;
    return { contentDelta, reasoningDelta };
  }

  /**
   * Push a chunk while in "reasoning" phase. Looks for </details> and
   * either accumulates reasoning or transitions back to content phase.
   * May recursively call push() if </details> is found and there's more
   * content after it.
   */
  function pushReasoning(
    chunk: string,
    thinkMode: "separate" | "strip" | "passthrough"
  ): DetailsParserResult {
    let contentDelta = "";
    let reasoningDelta = "";

    // If we have a pending partial close tag (e.g. "</det"), prepend it.
    let effectiveChunk = chunk;
    if (state.pendingTag) {
      effectiveChunk = state.pendingTag + chunk;
      state.pendingTag = "";
    }

    const closeIdx = effectiveChunk.indexOf("</details>");
    if (closeIdx === -1) {
      // No close tag — check for partial `</detail` at the end.
      const partialClose = findPartialCloseTag(effectiveChunk);
      if (partialClose > 0) {
        // Buffer the reasoning portion, keep the partial close tag.
        const reasoningPart = effectiveChunk.slice(0, effectiveChunk.length - partialClose);
        if (reasoningPart) {
          state.reasoningBuffer += reasoningPart;
          const cleaned = cleanReasoning(state.reasoningBuffer);
          if (cleaned.length > reasoningCleaned.length) {
            const delta = cleaned.slice(reasoningCleaned.length);
            reasoningCleaned = cleaned;
            if (thinkMode !== "strip") {
              reasoningDelta += delta;
            }
          }
        }
        state.pendingTag = effectiveChunk.slice(effectiveChunk.length - partialClose);
        // Stay in "reasoning" phase; pendingTag holds the partial close.
        return { contentDelta, reasoningDelta };
      }
      // Pure reasoning chunk — accumulate.
      state.reasoningBuffer += effectiveChunk;
      const cleaned = cleanReasoning(state.reasoningBuffer);
      if (cleaned.length > reasoningCleaned.length) {
        const delta = cleaned.slice(reasoningCleaned.length);
        reasoningCleaned = cleaned;
        if (thinkMode !== "strip") {
          reasoningDelta += delta;
        }
      }
      return { contentDelta, reasoningDelta };
    }

    // Close tag found — emit reasoning up to it, then process the rest.
    const reasoningPart = effectiveChunk.slice(0, closeIdx);
    if (reasoningPart) {
      state.reasoningBuffer += reasoningPart;
    }
    // Final flush of reasoning (clean and emit any new portion).
    const cleaned = cleanReasoning(state.reasoningBuffer);
    if (cleaned.length > reasoningCleaned.length) {
      const delta = cleaned.slice(reasoningCleaned.length);
      reasoningCleaned = cleaned;
      if (thinkMode !== "strip") {
        reasoningDelta += delta;
      }
    }
    state.reasoningBuffer = "";
    state.sentReasoningLength = reasoningCleaned.length;
    // Reset reasoningCleaned so the next <details> block starts fresh.
    // We've already emitted the delta above; the next block's reasoning
    // will be compared against an empty baseline, not the previous block.
    reasoningCleaned = "";

    // Skip past </details>.
    const afterClose = effectiveChunk.slice(closeIdx + "</details>".length);
    state.phase = "content";

    // If there's content after </details>, recurse to emit it as content.
    if (afterClose) {
      const sub = push(afterClose, thinkMode);
      contentDelta += sub.contentDelta;
      reasoningDelta += sub.reasoningDelta;
    }
    return { contentDelta, reasoningDelta };
  }

  /**
   * Look for a partial `</details>` close tag at the END of `chunk`.
   * Returns the length of the partial match, or 0 if none.
   * E.g. chunk ending with `</deta` returns 6.
   */
  function findPartialCloseTag(chunk: string): number {
    const closeTag = "</details>";
    // Check progressively shorter prefixes of the close tag.
    for (let len = closeTag.length - 1; len > 0; len--) {
      if (chunk.endsWith(closeTag.slice(0, len))) {
        return len;
      }
    }
    return 0;
  }

  /**
   * Look for a partial `<details` open tag at the END of `chunk`.
   * Returns the length of the partial match, or 0 if none.
   * E.g. chunk ending with `<deta` returns 5.
   */
  function findPartialTagStart(chunk: string): number {
    const openTag = "<details";
    for (let len = openTag.length - 1; len > 0; len--) {
      if (chunk.endsWith(openTag.slice(0, len))) {
        return len;
      }
    }
    return 0;
  }

  /**
   * Flush any remaining buffered state at end of stream.
   * If we're still inside reasoning (no </details> arrived), emit the
   * accumulated reasoning as a final delta.
   */
  function flush(
    thinkMode: "separate" | "strip" | "passthrough" = "separate"
  ): DetailsParserResult {
    let contentDelta = "";
    let reasoningDelta = "";

    if (state.phase === "tag-open") {
      // Incomplete opening tag — treat as content (best-effort).
      contentBuffer += state.pendingTag;
      contentDelta += state.pendingTag;
      state.pendingTag = "";
      state.phase = "content";
    } else if (state.phase === "reasoning") {
      // Prepend any pending partial close tag back to the reasoning buffer
      // (it was never a real close tag — stream ended mid-tag).
      if (state.pendingTag) {
        state.reasoningBuffer += state.pendingTag;
        state.pendingTag = "";
      }
      const cleaned = cleanReasoning(state.reasoningBuffer);
      if (cleaned.length > reasoningCleaned.length) {
        const delta = cleaned.slice(reasoningCleaned.length);
        reasoningCleaned = cleaned;
        if (thinkMode !== "strip") {
          reasoningDelta += delta;
        }
      }
      state.reasoningBuffer = "";
      state.phase = "content";
    }

    return { contentDelta, reasoningDelta };
  }

  function getState(): DetailsParserState {
    return { ...state };
  }

  return { push, flush, getState };
}
