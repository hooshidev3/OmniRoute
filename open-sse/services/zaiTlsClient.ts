/**
 * Browser-TLS-impersonating HTTP client for chat.z.ai.
 *
 * Why this exists: Z.AI sits behind Aliyun WAF (ESA) which blocks requests
 * from Node's native fetch (undici) with HTTP 405. This module wraps
 * `tls-client-node` (native shared library built from bogdanfinn/tls-client)
 * to send a Chrome handshake instead.
 *
 * Modeled after `grokTlsClient.ts` — kept as an independent module so changes
 * here cannot regress the grok-web path.
 *
 * @module services/zaiTlsClient
 */

import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { mkdtemp, open, unlink, rmdir, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";

let clientPromise: Promise<unknown> | null = null;
let exitHookInstalled = false;

const ZAI_PROFILE = "chrome_146";
const DEFAULT_TIMEOUT_MS =
  Number.parseInt(process.env.OMNIROUTE_ZAI_TLS_TIMEOUT_MS || "", 10) || 60_000;
const HARD_TIMEOUT_GRACE_MS =
  Number.parseInt(process.env.OMNIROUTE_ZAI_TLS_GRACE_MS || "", 10) || 10_000;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const stop = async () => {
    if (clientPromise === null) return;
    try {
      const c = (await clientPromise) as { stop?: () => Promise<unknown> };
      await c.stop?.();
    } catch {
      // ignore
    }
  };
  process.once("beforeExit", stop);
  process.once("SIGINT", () => {
    void stop();
  });
  process.once("SIGTERM", () => {
    void stop();
  });
}

function resetClientCache(): void {
  clientPromise = null;
}

export class TlsClientHangError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TlsClientHangError";
  }
}

async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | null | undefined
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let abortListener: (() => void) | null = null;
  try {
    const racers: Promise<T>[] = [
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new TlsClientHangError(
              `tls-client-node call exceeded ${timeoutMs}ms — native binding likely deadlocked`
            )
          );
        }, timeoutMs);
      }),
    ];
    if (signal) {
      racers.push(
        new Promise<T>((_, reject) => {
          if (signal.aborted) {
            reject(makeAbortError(signal));
            return;
          }
          abortListener = () => reject(makeAbortError(signal));
          signal.addEventListener("abort", abortListener, { once: true });
        })
      );
    }
    return await Promise.race(racers);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
  }
}

interface TlsResponseLike {
  status: number;
  headers: Record<string, string[]>;
  body: string;
  cookies?: Record<string, string>;
  text: () => Promise<string>;
  bytes: () => Promise<Uint8Array>;
  json: <T = unknown>() => Promise<T>;
}

async function getClient(): Promise<{
  request: (url: string, opts: Record<string, unknown>) => Promise<TlsResponseLike>;
}> {
  if (!clientPromise) {
    clientPromise = (async () => {
      try {
        const mod = await import("tls-client-node");
        const TLSClient = (mod as { TLSClient: new (opts?: Record<string, unknown>) => unknown })
          .TLSClient;
        const client = new TLSClient({ runtimeMode: "native" }) as {
          start: () => Promise<void>;
          request: (url: string, opts: Record<string, unknown>) => Promise<TlsResponseLike>;
        };
        await client.start();
        installExitHook();
        return client;
      } catch (err) {
        clientPromise = null;
        const msg = err instanceof Error ? err.message : String(err);
        throw new TlsClientUnavailableError(
          `TLS impersonation client failed to start: ${msg}. ` +
            `Verify tls-client-node is installed and its native binary downloaded.`
        );
      }
    })();
  }
  return clientPromise as Promise<{
    request: (url: string, opts: Record<string, unknown>) => Promise<TlsResponseLike>;
  }>;
}

export class TlsClientUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TlsClientUnavailableError";
  }
}

export interface TlsFetchOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal | null;
  stream?: boolean;
  streamEofSymbol?: string;
  proxyUrl?: string;
}

export interface TlsFetchResult {
  status: number;
  headers: Headers;
  text: string | null;
  body: ReadableStream<Uint8Array> | null;
}

// Test-only injection point
let testOverride: ((url: string, options: TlsFetchOptions) => Promise<TlsFetchResult>) | null =
  null;

export function __setTlsFetchOverrideForTesting(fn: typeof testOverride): void {
  testOverride = fn;
}

/**
 * Make a single HTTP request to chat.z.ai with a Chrome-like TLS fingerprint.
 *
 * Throws TlsClientUnavailableError if the native binary failed to load.
 */
export async function tlsFetchZai(
  url: string,
  options: TlsFetchOptions = {}
): Promise<TlsFetchResult> {
  if (testOverride) return testOverride(url, options);
  if (options.signal?.aborted) {
    throw makeAbortError(options.signal);
  }
  const client = await getClient();
  if (options.signal?.aborted) {
    throw makeAbortError(options.signal);
  }

  const requestOptions: Record<string, unknown> = {
    method: options.method || "GET",
    headers: options.headers || {},
    body: options.body,
    tlsClientIdentifier: ZAI_PROFILE,
    timeoutMilliseconds: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    followRedirects: true,
    withRandomTLSExtensionOrder: true,
  };

  if (options.stream) {
    return await tlsFetchStreaming(
      client,
      url,
      requestOptions,
      options.streamEofSymbol,
      options.signal ?? null,
      (options.timeoutMs ?? DEFAULT_TIMEOUT_MS) + HARD_TIMEOUT_GRACE_MS
    );
  }

  let tlsResponse: TlsResponseLike;
  try {
    tlsResponse = await raceWithTimeout(
      client.request(url, requestOptions),
      (options.timeoutMs ?? DEFAULT_TIMEOUT_MS) + HARD_TIMEOUT_GRACE_MS,
      options.signal ?? null
    );
  } catch (err) {
    if (err instanceof TlsClientHangError) {
      resetClientCache();
    }
    throw err;
  }
  if (options.signal?.aborted) {
    throw makeAbortError(options.signal);
  }
  return {
    status: tlsResponse.status,
    headers: toHeaders(tlsResponse.headers),
    text: tlsResponse.body,
    body: null,
  };
}

function makeAbortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === "string" ? reason : "The operation was aborted");
  err.name = "AbortError";
  return err;
}

function toHeaders(raw: Record<string, string[]>): Headers {
  const h = new Headers();
  for (const [k, vs] of Object.entries(raw || {})) {
    for (const v of vs) h.append(k, v);
  }
  return h;
}

/**
 * Returns true if the response body is an Aliyun WAF challenge page.
 */
export function isAliyunWafChallenge(text: string | null | undefined): boolean {
  if (!text) return false;
  return /blocked as it may cause|405 Method Not Allowed|Sorry, your request has been blocked/i.test(
    text
  );
}

// ─── Streaming via temp file ────────────────────────────────────────────────

async function tlsFetchStreaming(
  client: { request: (url: string, opts: Record<string, unknown>) => Promise<TlsResponseLike> },
  url: string,
  requestOptions: Record<string, unknown>,
  eofSymbol = "[DONE]",
  signal: AbortSignal | null = null,
  hardTimeoutMs: number = DEFAULT_TIMEOUT_MS + HARD_TIMEOUT_GRACE_MS
): Promise<TlsFetchResult> {
  const dir = await mkdtemp(join(tmpdir(), "zai-stream-"));
  const path = join(dir, `${randomUUID()}.sse`);

  const streamOpts = {
    ...requestOptions,
    streamOutputPath: path,
    streamOutputBlockSize: 1024,
    streamOutputEOFSymbol: eofSymbol,
  };

  let resetOnHang = true;
  const requestPromise = raceWithTimeout(
    client.request(url, streamOpts),
    hardTimeoutMs,
    signal
  ).catch((err: unknown) => {
    if (resetOnHang && err instanceof TlsClientHangError) {
      resetClientCache();
      resetOnHang = false;
    }
    throw err;
  });

  const ready = await waitForContent(path, 5_000, requestPromise);
  if (!ready) {
    const r = await requestPromise.catch(
      (e) => ({ status: 502, headers: {}, body: String(e) }) as TlsResponseLike
    );
    await cleanupTempPath(path);
    return {
      status: r.status,
      headers: toHeaders(r.headers),
      text: r.body,
      body: null,
    };
  }

  const peek = await readFirstBytes(path, 256);
  if (isAliyunWafChallenge(peek)) {
    await cleanupTempPath(path);
    return {
      status: 405,
      headers: new Headers({ "Content-Type": "text/html" }),
      text: peek,
      body: null,
    };
  }
  if (peek.trimStart().startsWith("<")) {
    await cleanupTempPath(path);
    return {
      status: 502,
      headers: new Headers({ "Content-Type": "text/html" }),
      text: peek,
      body: null,
    };
  }

  const stream = tailFile(path, eofSymbol, requestPromise, signal);
  const headers = new Headers({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
  });
  return { status: 200, headers, text: null, body: stream };
}

async function cleanupTempPath(path: string): Promise<void> {
  await unlink(path).catch(() => {});
  await rmdir(dirname(path)).catch(() => {});
}

async function readFirstBytes(path: string, n: number): Promise<string> {
  const fd = await open(path, "r");
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fd.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fd.close().catch(() => {});
  }
}

async function waitForContent(
  path: string,
  timeoutMs: number,
  requestPromise: Promise<TlsResponseLike>
): Promise<boolean> {
  let requestSettled = false;
  requestPromise.then(
    () => {
      requestSettled = true;
    },
    () => {
      requestSettled = true;
    }
  );
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const s = await stat(path);
      if (s.size > 0) return true;
    } catch {
      // file doesn't exist yet
    }
    if (requestSettled) return false;
    await sleep(25);
  }
  return false;
}

function tailFile(
  path: string,
  eofSymbol: string,
  done: Promise<TlsResponseLike>,
  signal: AbortSignal | null = null
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const fd = await open(path, "r");
      const buf = Buffer.alloc(64 * 1024);
      let offset = 0;
      let finished = false;
      let aborted = false;
      let upstreamError: Error | null = null;

      done.then(
        () => {
          finished = true;
        },
        (err) => {
          upstreamError = err instanceof Error ? err : new Error(String(err));
          finished = true;
        }
      );

      const onAbort = () => {
        aborted = true;
      };
      if (signal) {
        if (signal.aborted) aborted = true;
        else signal.addEventListener("abort", onAbort, { once: true });
      }

      let errored = false;
      try {
        while (!aborted) {
          const { bytesRead } = await fd.read(buf, 0, buf.length, offset);
          if (bytesRead > 0) {
            const chunk = buf.subarray(0, bytesRead);
            offset += bytesRead;
            const text = chunk.toString("utf8");
            if (text.includes(eofSymbol)) {
              const beforeEof = text.substring(0, text.indexOf(eofSymbol));
              if (beforeEof) controller.enqueue(Buffer.from(beforeEof, "utf8"));
              controller.close();
              return;
            }
            controller.enqueue(Buffer.from(chunk));
          }
          if (finished) {
            while (true) {
              const { bytesRead } = await fd.read(buf, 0, buf.length, offset);
              if (bytesRead === 0) break;
              const chunk = buf.subarray(0, bytesRead);
              offset += bytesRead;
              const text = chunk.toString("utf8");
              if (text.includes(eofSymbol)) {
                const beforeEof = text.substring(0, text.indexOf(eofSymbol));
                if (beforeEof) controller.enqueue(Buffer.from(beforeEof, "utf8"));
                controller.close();
                return;
              }
              controller.enqueue(Buffer.from(chunk));
            }
            if (upstreamError && !errored) {
              errored = true;
              controller.error(upstreamError);
              return;
            }
            controller.close();
            return;
          }
          await sleep(25);
        }
      } catch (err) {
        if (!errored) {
          errored = true;
          controller.error(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        await fd.close().catch(() => {});
        await cleanupTempPath(path);
        if (signal) signal.removeEventListener("abort", onAbort);
      }
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
