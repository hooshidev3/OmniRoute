/**
 * OpenAI tool-call translation for Z.AI web executor.
 *
 * Z.AI's web endpoint supports OpenAI-compatible tool calling via the
 * `tools` field in the request body. Tool calls appear in the SSE stream
 * as `choices[0].delta.tool_calls` chunks, matching the OpenAI format.
 *
 * This module provides:
 *   - `buildZaiToolRegistry`: extract tool definitions from the OpenAI request
 *   - `parseZaiToolCallDelta`: parse tool call deltas from SSE chunks
 *   - `enqueueStreamingToolCalls`: emit OpenAI-shaped tool call SSE chunks
 *
 * @module zai-web-free/tool-bridge
 */

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ZaiToolRegistry {
  enabled: boolean;
  toolsByName: Map<string, { name: string; description?: string; parameters: unknown }>;
}

/**
 * Build a tool registry from the OpenAI request body's `tools` field.
 * Returns a disabled registry if no tools are present.
 */
export function buildZaiToolRegistry(body: Record<string, unknown>): ZaiToolRegistry {
  const tools = body.tools as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(tools) || tools.length === 0) {
    return { enabled: false, toolsByName: new Map() };
  }

  const toolsByName = new Map<
    string,
    { name: string; description?: string; parameters: unknown }
  >();
  for (const tool of tools) {
    const fn = tool.function as Record<string, unknown> | undefined;
    if (!fn || typeof fn.name !== "string") continue;
    toolsByName.set(fn.name, {
      name: fn.name,
      description: typeof fn.description === "string" ? fn.description : undefined,
      parameters: fn.parameters ?? {},
    });
  }

  return { enabled: toolsByName.size > 0, toolsByName };
}

/**
 * Parse a tool_calls delta from a Z.AI SSE chunk.
 * Returns null if the chunk doesn't contain tool call data.
 */
export function parseZaiToolCallDelta(
  chunk: Record<string, unknown>
): Array<{
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}> | null {
  const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(choices) || choices.length === 0) return null;

  const delta = choices[0]?.delta as Record<string, unknown> | undefined;
  if (!delta) return null;

  const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return null;

  return toolCalls.map((tc) => ({
    index: typeof tc.index === "number" ? tc.index : 0,
    id: typeof tc.id === "string" ? tc.id : undefined,
    type: typeof tc.type === "string" ? tc.type : "function",
    function: tc.function as { name?: string; arguments?: string } | undefined,
  }));
}

/**
 * Enqueue OpenAI-shaped tool call SSE chunks into the streaming controller.
 *
 * Emits one chunk per tool call, followed by a finish chunk with
 * `finish_reason: "tool_calls"`, then `[DONE]`.
 */
export function enqueueStreamingToolCalls(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  params: {
    id: string;
    created: number;
    model: string;
    fingerprint: string;
    toolCalls: OpenAIToolCall[];
  }
): void {
  for (let i = 0; i < params.toolCalls.length; i++) {
    controller.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({
          id: params.id,
          object: "chat.completion.chunk",
          created: params.created,
          model: params.model,
          system_fingerprint: params.fingerprint || null,
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: i, ...params.toolCalls[i] }] },
              finish_reason: null,
              logprobs: null,
            },
          ],
        })}\n\n`
      )
    );
  }
  controller.enqueue(
    encoder.encode(
      `data: ${JSON.stringify({
        id: params.id,
        object: "chat.completion.chunk",
        created: params.created,
        model: params.model,
        system_fingerprint: params.fingerprint || null,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls", logprobs: null }],
      })}\n\n`
    )
  );
  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
}

/**
 * Accumulate tool call deltas across multiple SSE chunks.
 * Returns the completed tool calls when all arguments are received.
 */
export class ToolCallAccumulator {
  private calls: Map<number, { id: string; name: string; arguments: string }> = new Map();

  feed(
    deltas: Array<{
      index: number;
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>
  ): void {
    for (const d of deltas) {
      const existing = this.calls.get(d.index) ?? { id: "", name: "", arguments: "" };
      if (d.id) existing.id = d.id;
      if (d.function?.name) existing.name = d.function.name;
      if (d.function?.arguments) existing.arguments += d.function.arguments;
      this.calls.set(d.index, existing);
    }
  }

  getCompleted(): OpenAIToolCall[] {
    const result: OpenAIToolCall[] = [];
    const sorted = [...this.calls.entries()].sort((a, b) => a[0] - b[0]);
    for (const [, tc] of sorted) {
      if (tc.name) {
        result.push({
          id: tc.id || `call_${Date.now().toString(36)}`,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments || "{}" },
        });
      }
    }
    return result;
  }

  hasPending(): boolean {
    return this.calls.size > 0;
  }
}
