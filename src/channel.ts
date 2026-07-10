import type { ChannelPlugin, OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/core";

import {
  loadMyCowlabAccount,
  saveMyCowlabAccount,
  listMyCowlabAccountIds,
  resolveMyCowlabAccount,
  triggerMyCowlabChannelReload,
  SINGLE_ACCOUNT_ID,
} from "./auth/accounts.js";
import type { ResolvedMyCowlabAccount } from "./auth/accounts.js";
import { getContextToken, restoreContextTokens } from "./messaging/inbound.js";
import { loadStaticTokenConfig } from "./auth/login.js";
import { logger } from "./util/logger.js";
import { applyMyCowlabMessageSendingHook, emitMyCowlabMessageSent } from "./messaging/outbound-hooks.js";
import { sendMessageMyCowlab, StreamingMarkdownFilter } from "./messaging/send.js";

/**
 * Resolve the effective accountId for an outbound message when the caller
 * did not provide one. The MVP has exactly one fixed account; for any
 * non-empty accountId, validate it; otherwise default to the singleton.
 */
function resolveOutboundAccountId(
  cfg: OpenClawConfig,
  accountId: string | null | undefined,
): string {
  const allIds = listMyCowlabAccountIds(cfg);
  if (allIds.length === 0) {
    throw new Error(
      `cowlab: no account registered — run \`openclaw channels login --channel openclaw-cowlab\``,
    );
  }
  if (accountId && accountId.trim()) {
    if (!allIds.includes(accountId)) {
      throw new Error(
        `cowlab: accountId="${accountId}" is not registered (only "${allIds[0]}" is available)`,
      );
    }
    return accountId;
  }
  return allIds[0];
}

async function sendMyCowlabOutbound(params: {
  cfg: OpenClawConfig;
  to: string;
  text: string;
  accountId?: string | null;
  contextToken?: string;
}): Promise<{ channel: string; messageId: string }> {
  const account = resolveMyCowlabAccount(params.cfg, params.accountId);
  const aLog = logger.withAccount(account.accountId);

  if (!account.configured || !account.apiUrl) {
    aLog.error(`sendMyCowlabOutbound: account not configured`);
    throw new Error(
      "cowlab not configured: please run `openclaw channels login --channel openclaw-cowlab`",
    );
  }
  if (!params.contextToken) {
    aLog.debug(`sendMyCowlabOutbound: contextToken missing for to=${params.to}, sending without context`);
  }
  const f = new StreamingMarkdownFilter();
  const rawText = params.text ?? "";
  let filteredText = f.feed(rawText) + f.flush();

  const sendingResult = await applyMyCowlabMessageSendingHook({
    to: params.to,
    text: filteredText,
    accountId: account.accountId,
  });
  if (sendingResult.cancelled) {
    aLog.info(`sendMyCowlabOutbound: cancelled by message_sending hook to=${params.to}`);
    return { channel: "openclaw-cowlab", messageId: "" };
  }
  filteredText = sendingResult.text;

  try {
    const result = await sendMessageMyCowlab({
      to: params.to,
      text: filteredText,
      opts: {
        apiUrl: account.apiUrl,
        token: account.token,
        contextToken: params.contextToken,
      },
    });
    emitMyCowlabMessageSent({
      to: params.to,
      content: filteredText,
      success: true,
      accountId: account.accountId,
    });
    return { channel: "openclaw-cowlab", messageId: result.messageId };
  } catch (err) {
    emitMyCowlabMessageSent({
      to: params.to,
      content: filteredText,
      success: false,
      error: String(err),
      accountId: account.accountId,
    });
    throw err;
  }
}

export const myAppPlugin: ChannelPlugin<ResolvedMyCowlabAccount> = {
  id: "openclaw-cowlab",
  meta: {
    id: "openclaw-cowlab",
    label: "openclaw-cowlab",
    selectionLabel: "openclaw-cowlab (long-poll)",
    docsPath: "/channels/openclaw-cowlab",
    docsLabel: "openclaw-cowlab",
    blurb: "long-poll upstream, sendMessage downstream; bearer token auth.",
    order: 75,
  },
  configSchema: {
    schema: {
      type: "object",
      additionalProperties: true,
    },
  },
  capabilities: {
    chatTypes: ["direct"],
    media: false,
    blockStreaming: true,
  },
  streaming: {
    blockStreamingCoalesceDefaults: {
      minChars: 200,
      idleMs: 3000,
    },
  },
  messaging: {
    targetResolver: {
      // No fixed user-id format — accept any non-empty string as a direct id.
      looksLikeId: (raw) => typeof raw === "string" && raw.trim().length > 0,
    },
  },
  agentPrompt: {
    messageToolHints: () => [
      "To reply to the current user, just send a text message. The current conversation recipient is used automatically — you do not need to specify 'to'.",
      "IMPORTANT: The cowlab channel does not support media in the MVP. Text only.",
      "IMPORTANT: When creating a cron job (scheduled task) for the current cowlab user, you MUST set delivery.to to the user's ID (from the current conversation) AND set delivery.accountId to the current AccountId. Without an explicit 'to', the cron delivery will fail with 'requires target'. Example: delivery: { mode: 'announce', channel: 'openclaw-cowlab', to: '<current_user_id>', accountId: '<current_AccountId>' }.",
    ],
  },
  reload: { configPrefixes: ["channels.openclaw-cowlab"] },
  config: {
    listAccountIds: (cfg) => listMyCowlabAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveMyCowlabAccount(cfg, accountId),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
    }),
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    sendText: async (ctx) => {
      const accountId = ctx.accountId || resolveOutboundAccountId(ctx.cfg, ctx.to);
      return sendMyCowlabOutbound({
        cfg: ctx.cfg,
        to: ctx.to,
        text: ctx.text,
        accountId,
        contextToken: getContextToken(accountId, ctx.to),
      });
    },
    sendMedia: async (ctx) => {
      throw new Error(
        "cowlab channel: media is not supported in the MVP — send a text message instead",
      );
    },
  },
  status: {
    defaultRuntime: {
      accountId: "",
      lastError: null,
      lastInboundAt: null,
      lastOutboundAt: null,
    },
    collectStatusIssues: () => [],
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      lastError: snapshot.lastError ?? null,
      lastInboundAt: snapshot.lastInboundAt ?? null,
      lastOutboundAt: snapshot.lastOutboundAt ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      ...runtime,
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
    }),
  },
  auth: {
    login: async ({ cfg, accountId, runtime }) => {
      const account = resolveMyCowlabAccount(cfg, accountId);
      const aLog = logger.withAccount(account.accountId);
      const log = (msg: string) => runtime?.log?.(msg);

      log(`Loading cowlab config...`);
      const { apiUrl, token } = loadStaticTokenConfig(cfg);
      aLog.info(`auth.login: got apiUrl=${apiUrl} token=*** (len=${token.length})`);

      try {
        saveMyCowlabAccount(account.accountId, { token, apiUrl });
        await triggerMyCowlabChannelReload();
        log(`\n✅ cowlab account "${account.accountId}" configured (apiUrl=${apiUrl}).`);
      } catch (err) {
        aLog.error(`auth.login: failed to save account data err=${String(err)}`);
        log(`⚠️  保存账号数据失败: ${String(err)}`);
        throw err;
      }
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      if (!ctx) {
        logger.warn(`gateway.startAccount: called with undefined ctx, skipping`);
        return;
      }
      const account = ctx.account;
      const aLog = logger.withAccount(account.accountId);
      aLog.debug(`about to call monitorMyCowlabProvider`);

      if (!account.configured || !account.apiUrl || !account.token) {
        const msg = "cowlab not configured — run: openclaw channels login --channel openclaw-cowlab";
        aLog.error(msg);
        ctx.log?.error?.(`[${account.accountId}] ${msg}`);
        ctx.setStatus?.({ accountId: account.accountId, running: false });
        throw new Error(msg);
      }

      ctx.setStatus?.({
        accountId: account.accountId,
        running: true,
        lastStartAt: Date.now(),
        lastEventAt: Date.now(),
      });

      ctx.log?.info?.(`[${account.accountId}] starting cowlab provider (${account.apiUrl})`);

      const logPath = aLog.getLogFilePath();
      ctx.log?.info?.(`[${account.accountId}] cowlab logs: ${logPath}`);

      if (!ctx.channelRuntime) {
        const msg = `ctx.channelRuntime missing — host too old or plugin SDK contract violated`;
        aLog.error(msg);
        ctx.log?.error?.(`[${account.accountId}] ${msg}`);
        ctx.setStatus?.({ accountId: account.accountId, running: false });
        throw new Error(msg);
      }

      restoreContextTokens(account.accountId);

      // Lazy-import to avoid pulling in the monitor -> process-message ->
      // command-auth chain during plugin registration.
      const { monitorMyCowlabProvider } = await import("./monitor/monitor.js");
      return monitorMyCowlabProvider({
        apiUrl: account.apiUrl,
        token: account.token,
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        channelRuntime: ctx.channelRuntime as unknown as PluginRuntime["channel"],
        abortSignal: ctx.abortSignal,
        setStatus: ctx.setStatus,
      });
    },
    stopAccount: async (ctx) => {
      const account = ctx.account;
      const aLog = logger.withAccount(account.accountId);
      if (!account.configured || !account.token?.trim()) {
        aLog.debug(`gateway.stopAccount: skip (not configured)`);
        return;
      }
      // No notifyStop equivalent for the user's backend — the long-poll
      // is aborted via ctx.abortSignal above, which the monitor plumbs into
      // the fetch request. Nothing else to do on stop.
      aLog.info(`gateway.stopAccount: stop signal sent (abortSignal aborted=${ctx.abortSignal?.aborted})`);
    },
  },
};
