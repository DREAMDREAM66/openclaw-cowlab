import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";

import { getUpdates } from "../api/client.js";
import { processOneMessage } from "../messaging/process-message.js";
import { getSyncBufFilePath, loadGetUpdatesBuf, saveGetUpdatesBuf } from "../storage/sync-buf.js";
import { logger } from "../util/logger.js";
import type { Logger } from "../util/logger.js";

const DEFAULT_LONG_POLL_TIMEOUT_SEC = 35;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;

export type MonitorMyCowlabOpts = {
  apiUrl: string;
  token?: string;
  accountId: string;
  /** When non-empty, only messages whose `from` is in this list are processed. */
  allowFrom?: string[];
  config: import("openclaw/plugin-sdk/core").OpenClawConfig;
  runtime?: { log?: (msg: string) => void; error?: (msg: string) => void };
  /**
   * Gateway-injected channel runtime surface (reply/routing/session/media/commands/...).
   * Required for inbound message processing; provided by `ChannelGatewayContext.channelRuntime`.
   */
  channelRuntime: PluginRuntime["channel"];
  abortSignal?: AbortSignal;
  longPollTimeoutSec?: number;
  /** Gateway status callback — called on each successful poll and inbound message. */
  setStatus?: (next: ChannelAccountSnapshot) => void;
};

/**
 * Long-poll loop: getUpdates -> processOneMessage -> repeat.
 * Runs until `abortSignal` aborts.
 */
export async function monitorMyCowlabProvider(opts: MonitorMyCowlabOpts): Promise<void> {
  const {
    apiUrl,
    token,
    accountId,
    config,
    channelRuntime,
    abortSignal,
    longPollTimeoutSec,
    setStatus,
  } = opts;
  const log = opts.runtime?.log ?? (() => {});
  const errLog = opts.runtime?.error ?? ((m: string) => log(m));
  const aLog: Logger = logger.withAccount(accountId);

  if (!channelRuntime) {
    const msg =
      "channelRuntime missing on monitor opts; gateway must inject ChannelGatewayContext.channelRuntime";
    aLog.error(msg);
    throw new Error(msg);
  }
  if (!token?.trim()) {
    const msg = "monitor: missing token (run `openclaw channels login --channel openclaw-cowlab`)";
    aLog.error(msg);
    throw new Error(msg);
  }

  log(`cowlab monitor started (${apiUrl}, account=${accountId})`);
  aLog.info(
    `Monitor started: apiUrl=${apiUrl} timeoutSec=${longPollTimeoutSec ?? DEFAULT_LONG_POLL_TIMEOUT_SEC}`,
  );

  const syncFilePath = getSyncBufFilePath(accountId);
  aLog.debug(`syncFilePath: ${syncFilePath}`);

  const previousCursor = loadGetUpdatesBuf(syncFilePath);
  let cursor = previousCursor ?? "";

  if (previousCursor) {
    log(`[cowlab] resuming from previous cursor (${cursor.length} bytes)`);
    aLog.debug(`Using previous cursor (${cursor.length} bytes)`);
  } else {
    log(`[cowlab] no previous cursor, starting fresh`);
    aLog.info(`No previous cursor found, starting fresh`);
  }

  const timeoutSec = longPollTimeoutSec ?? DEFAULT_LONG_POLL_TIMEOUT_SEC;
  let consecutiveFailures = 0;

  while (!abortSignal?.aborted) {
    try {
      aLog.debug(`getUpdates: cursor=${cursor.slice(0, 50) || "<empty>"}..., timeoutSec=${timeoutSec}`);
      const resp = await getUpdates({
        apiUrl,
        token,
        cursor,
        timeoutSec,
        // Plumb the gateway's abort signal into the underlying fetch so a
        // channel hot reload terminates the in-flight long-poll within ms
        // (instead of waiting up to ~35s for the long-poll timeout).
        abortSignal,
      });
      aLog.debug(
        `getUpdates response: messages=${resp.messages?.length ?? 0} cursorLen=${resp.cursor?.length ?? 0}`,
      );

      consecutiveFailures = 0;
      setStatus?.({ accountId, lastEventAt: Date.now() });

      // Persist the cursor returned by the backend, even if empty (some
      // backends reset the cursor to "" after delivery).
      if (typeof resp.cursor === "string" && resp.cursor !== cursor) {
        saveGetUpdatesBuf(syncFilePath, resp.cursor);
        cursor = resp.cursor;
        aLog.debug(`Saved new cursor (${cursor.length} bytes)`);
      }

      const list = resp.messages ?? [];
      for (const full of list) {
        aLog.info(
          `inbound message: id=${full.id} from=${full.from} textLen=${full.text.length}`,
        );

        const now = Date.now();
        setStatus?.({ accountId, lastEventAt: now, lastInboundAt: now });

        // allowFrom filtering is delegated to processOneMessage via the framework
        // authorization pipeline (resolveSenderCommandAuthorizationWithRuntime).

        await processOneMessage(full, {
          accountId,
          config,
          channelRuntime,
          apiUrl,
          token,
          log: opts.runtime?.log ?? (() => {}),
          errLog,
        });
      }
    } catch (err) {
      if (abortSignal?.aborted) {
        aLog.info(`Monitor stopped (aborted)`);
        return;
      }
      consecutiveFailures += 1;
      errLog(
        `cowlab getUpdates error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${String(err)}`,
      );
      aLog.error(`getUpdates error: ${String(err)}, stack=${(err as Error).stack}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        errLog(
          `cowlab getUpdates: ${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off 30s`,
        );
        aLog.error(
          `getUpdates: ${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off 30s`,
        );
        consecutiveFailures = 0;
        await sleep(BACKOFF_DELAY_MS, abortSignal);
      } else {
        await sleep(RETRY_DELAY_MS, abortSignal);
      }
    }
  }
  aLog.info(`Monitor ended`);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}
