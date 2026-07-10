import { logger } from "../util/logger.js";
import { redactBody, redactUrl } from "../util/redact.js";

import type { GetUpdatesResp, SendMessageReq, SendMessageResp } from "./types.js";

/** Default long-poll timeout in seconds. Matches the WeChat getUpdates default. */
export const DEFAULT_LONG_POLL_TIMEOUT_SEC = 35;

/** Client-side ceiling for non-long-poll requests (sendMessage, etc.). */
const DEFAULT_API_TIMEOUT_MS = 15_000;

export type MyCowlabClientOptions = {
  apiUrl: string;
  token?: string;
  abortSignal?: AbortSignal;
};

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function combineAbortSignals(
  internal: AbortController | undefined,
  external: AbortSignal | undefined,
): { signal?: AbortSignal; cleanup: () => void } {
  if (!internal && !external) return { cleanup: () => {} };
  if (!internal) return { signal: external, cleanup: () => {} };
  if (!external) return { signal: internal.signal, cleanup: () => {} };

  if (external.aborted) {
    internal.abort();
    return { signal: internal.signal, cleanup: () => {} };
  }

  const onExternalAbort = () => internal.abort();
  external.addEventListener("abort", onExternalAbort, { once: true });
  return {
    signal: internal.signal,
    cleanup: () => external.removeEventListener("abort", onExternalAbort),
  };
}

function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function apiRequest<T>(opts: {
  apiUrl: string;
  endpoint: string;
  method: "GET" | "POST";
  body?: unknown;
  token?: string;
  timeoutMs?: number;
  label: string;
  abortSignal?: AbortSignal;
}): Promise<T> {
  const base = ensureTrailingSlash(opts.apiUrl);
  const url = new URL(opts.endpoint, base);
  const hdrs = buildHeaders(opts.token);
  const bodyText = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  logger.debug(
    `${opts.method} ${redactUrl(url.toString())} body=${bodyText ? redactBody(bodyText) : "<none>"}`,
  );

  const controller =
    opts.timeoutMs !== undefined ? new AbortController() : undefined;
  const t =
    controller != null && opts.timeoutMs !== undefined
      ? setTimeout(() => controller.abort(), opts.timeoutMs)
      : undefined;
  const { signal, cleanup } = combineAbortSignals(controller, opts.abortSignal);

  try {
    const res = await fetch(url.toString(), {
      method: opts.method,
      headers: hdrs,
      ...(bodyText ? { body: bodyText } : {}),
      ...(signal ? { signal } : {}),
    });
    const rawText = await res.text();
    logger.debug(`${opts.label} status=${res.status} raw=${redactBody(rawText)}`);
    if (!res.ok) {
      throw new Error(`${opts.label} ${res.status}: ${rawText}`);
    }
    if (!rawText) {
      throw new Error(`${opts.label} ${res.status}: empty response body`);
    }
    return JSON.parse(rawText) as T;
  } finally {
    if (t !== undefined) clearTimeout(t);
    cleanup();
  }
}

/**
 * Long-poll the backend for new messages.
 *
 * Server should hold the request up to `timeoutSec` seconds, returning
 * `{ messages: [], cursor: "<unchanged>" }` on idle. Returns the parsed
 * response.
 *
 * On client-side timeout, `AbortError` is caught and an empty response is
 * returned so the caller can simply retry. On external abort (e.g. gateway
 * stop), the error is re-thrown so the caller can exit its loop.
 */
export async function getUpdates(
  opts: MyCowlabClientOptions & {
    cursor: string;
    timeoutSec?: number;
  },
): Promise<GetUpdatesResp> {
  const timeoutSec = opts.timeoutSec ?? DEFAULT_LONG_POLL_TIMEOUT_SEC;
  const endpoint =
    `v1/messages/poll?timeout=${encodeURIComponent(String(timeoutSec))}` +
    `&cursor=${encodeURIComponent(opts.cursor)}`;

  try {
    return await apiRequest<GetUpdatesResp>({
      apiUrl: opts.apiUrl,
      endpoint,
      method: "GET",
      token: opts.token,
      timeoutMs: (timeoutSec + 5) * 1000,
      label: "getUpdates",
      abortSignal: opts.abortSignal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      if (opts.abortSignal?.aborted) {
        logger.debug(`getUpdates: aborted by external signal`);
        throw err;
      }
      logger.debug(
        `getUpdates: client-side timeout after ${timeoutSec}s, returning empty response`,
      );
      return { messages: [], cursor: opts.cursor };
    }
    throw err;
  }
}

/** Send a single text message downstream. */
export async function sendMessage(
  opts: MyCowlabClientOptions & SendMessageReq,
): Promise<SendMessageResp> {
  const body: SendMessageReq = {
    to: opts.to,
    text: opts.text,
    ...(opts.contextToken ? { contextToken: opts.contextToken } : {}),
  };
  return apiRequest<SendMessageResp>({
    apiUrl: opts.apiUrl,
    endpoint: "v1/messages",
    method: "POST",
    body,
    token: opts.token,
    timeoutMs: DEFAULT_API_TIMEOUT_MS,
    label: "sendMessage",
    abortSignal: opts.abortSignal,
  });
}
