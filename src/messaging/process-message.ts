import {
  resolveSenderCommandAuthorizationWithRuntime,
  resolveDirectDmAuthorizationOutcome,
} from "openclaw/plugin-sdk/command-auth";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";

import { readFrameworkAllowFromList } from "../auth/pairing.js";
import { logger } from "../util/logger.js";
import { redactBody } from "../util/redact.js";

import type { MyCowlabMessage } from "../api/types.js";
import { sendMyCowlabErrorNotice } from "./error-notice.js";
import { applyMyCowlabMessageSendingHook, emitMyCowlabMessageSent } from "./outbound-hooks.js";
import {
  setContextToken,
  myAppMessageToMsgContext,
  getContextTokenFromMsgContext,
} from "./inbound.js";
import { StreamingMarkdownFilter } from "./markdown-filter.js";
import { sendMessageMyCowlab } from "./send.js";
import { handleSlashCommand } from "./slash-commands.js";

/** Dependencies for processOneMessage, injected by the monitor loop. */
export type ProcessMessageDeps = {
  accountId: string;
  config: import("openclaw/plugin-sdk/core").OpenClawConfig;
  channelRuntime: PluginRuntime["channel"];
  apiUrl: string;
  token?: string;
  log: (msg: string) => void;
  errLog: (m: string) => void;
};

/**
 * Process a single inbound message: route → dispatch reply.
 * Extracted from the monitor loop to keep monitoring and message handling separate.
 */
export async function processOneMessage(
  msg: MyCowlabMessage,
  deps: ProcessMessageDeps,
): Promise<void> {
  if (!deps?.channelRuntime) {
    logger.error(
      `processOneMessage: channelRuntime is undefined, skipping message from=${msg.from}`,
    );
    deps.errLog("processOneMessage: channelRuntime is undefined, skip");
    return;
  }

  const receivedAt = Date.now();
  const textBody = msg.text ?? "";

  if (textBody.startsWith("/")) {
    const slashResult = await handleSlashCommand(textBody, {
      to: msg.from,
      contextToken: msg.contextToken,
      apiUrl: deps.apiUrl,
      token: deps.token,
      accountId: deps.accountId,
      log: deps.log,
      errLog: deps.errLog,
    }, receivedAt, msg.timestamp);
    if (slashResult.handled) {
      logger.info(`[cowlab] Slash command handled, skipping AI pipeline`);
      return;
    }
  }

  const ctx = myAppMessageToMsgContext(msg, deps.accountId);

  // --- Framework command authorization ---
  const rawBody = ctx.Body?.trim() ?? "";
  ctx.CommandBody = rawBody;

  const senderId = msg.from ?? "";

  const { senderAllowedForCommands, commandAuthorized } =
    await resolveSenderCommandAuthorizationWithRuntime({
      cfg: deps.config,
      rawBody,
      isGroup: false,
      dmPolicy: "pairing",
      configuredAllowFrom: [],
      configuredGroupAllowFrom: [],
      senderId,
      isSenderAllowed: (id: string, list: string[]) => list.length === 0 || list.includes(id),
      /** Pairing: framework credentials `*-allowFrom.json`. */
      readAllowFromStore: async () => readFrameworkAllowFromList(deps.accountId),
      runtime: deps.channelRuntime.commands,
    });

  const directDmOutcome = resolveDirectDmAuthorizationOutcome({
    isGroup: false,
    dmPolicy: "pairing",
    senderAllowedForCommands,
  });

  if (directDmOutcome === "disabled" || directDmOutcome === "unauthorized") {
    logger.info(
      `authorization: dropping message from=${senderId} outcome=${directDmOutcome}`,
    );
    return;
  }

  ctx.CommandAuthorized = commandAuthorized;
  logger.debug(
    `authorization: senderId=${senderId} commandAuthorized=${String(commandAuthorized)} senderAllowed=${String(senderAllowedForCommands)}`,
  );

  const route = deps.channelRuntime.routing.resolveAgentRoute({
    cfg: deps.config,
    channel: "openclaw-cowlab",
    accountId: deps.accountId,
    peer: { kind: "direct", id: ctx.To },
  });
  logger.debug(
    `resolveAgentRoute: agentId=${route.agentId ?? "(none)"} sessionKey=${route.sessionKey ?? "(none)"} mainSessionKey=${route.mainSessionKey ?? "(none)"}`,
  );
  if (!route.agentId) {
    logger.error(
      `resolveAgentRoute: no agentId resolved for peer=${ctx.To} accountId=${deps.accountId} — message will not be dispatched`,
    );
  }

  ctx.SessionKey = route.sessionKey;
  const storePath = deps.channelRuntime.session.resolveStorePath(deps.config.session?.store, {
    agentId: route.agentId,
  });
  const finalized = deps.channelRuntime.reply.finalizeInboundContext(
    ctx as Parameters<typeof deps.channelRuntime.reply.finalizeInboundContext>[0],
  );

  logger.info(
    `inbound: from=${finalized.From} to=${finalized.To} bodyLen=${(finalized.Body ?? "").length}`,
  );
  logger.debug(`inbound context: ${redactBody(JSON.stringify(finalized))}`);

  await deps.channelRuntime.session.recordInboundSession({
    storePath,
    sessionKey: route.sessionKey,
    ctx: finalized as Parameters<typeof deps.channelRuntime.session.recordInboundSession>[0]["ctx"],
    updateLastRoute: {
      sessionKey: route.mainSessionKey,
      channel: "openclaw-cowlab",
      to: ctx.To,
      accountId: deps.accountId,
    },
    onRecordError: (err) => deps.errLog(`recordInboundSession: ${String(err)}`),
  });
  logger.debug(
    `recordInboundSession: done storePath=${storePath} sessionKey=${route.sessionKey ?? "(none)"}`,
  );

  const contextToken = getContextTokenFromMsgContext(ctx);
  if (contextToken) {
    setContextToken(deps.accountId, msg.from ?? "", contextToken);
  }
  const humanDelay = deps.channelRuntime.reply.resolveHumanDelayConfig(deps.config, route.agentId);

  const { dispatcher, replyOptions } =
    deps.channelRuntime.reply.createReplyDispatcherWithTyping({
      humanDelay,
      deliver: async (payload) => {
        const rawText = payload.text ?? "";
        let text = (() => {
          const f = new StreamingMarkdownFilter();
          return f.feed(rawText) + f.flush();
        })();
        logger.debug(`outbound payload: ${redactBody(JSON.stringify(payload))}`);
        logger.info(
          `outbound: to=${ctx.To} contextToken=${contextToken ? "present" : "none"} textLen=${text.length}`,
        );

        const sendingResult = await applyMyCowlabMessageSendingHook({
          to: ctx.To,
          text,
          accountId: deps.accountId,
        });
        if (sendingResult.cancelled) {
          logger.info(`outbound: cancelled by message_sending hook to=${ctx.To}`);
          return;
        }
        text = sendingResult.text;

        try {
          await sendMessageMyCowlab({
            to: ctx.To,
            text,
            opts: { apiUrl: deps.apiUrl, token: deps.token, contextToken },
          });
          emitMyCowlabMessageSent({ to: ctx.To, content: text, success: true, accountId: deps.accountId });
          logger.info(`outbound: text sent OK to=${ctx.To}`);
        } catch (err) {
          emitMyCowlabMessageSent({ to: ctx.To, content: text, success: false, error: String(err), accountId: deps.accountId });
          logger.error(
            `outbound: FAILED to=${ctx.To} err=${String(err)} stack=${(err as Error).stack ?? ""}`,
          );
          throw err;
        }
      },
      onError: (err, info) => {
        deps.errLog(`cowlab reply ${info.kind}: ${String(err)}`);
        const errMsg = err instanceof Error ? err.message : String(err);
        const notice = `⚠️ 消息发送失败：${errMsg}`;
        void sendMyCowlabErrorNotice({
          to: ctx.To,
          contextToken,
          message: notice,
          apiUrl: deps.apiUrl,
          token: deps.token,
          errLog: deps.errLog,
        });
      },
    });

  logger.debug(`dispatchReplyFromConfig: starting agentId=${route.agentId ?? "(none)"}`);
  try {
    await deps.channelRuntime.reply.withReplyDispatcher({
      dispatcher,
      run: () =>
        deps.channelRuntime.reply.dispatchReplyFromConfig({
          ctx: finalized,
          cfg: deps.config,
          dispatcher,
          replyOptions: { ...replyOptions, disableBlockStreaming: true },
        }),
    });
    logger.debug(`dispatchReplyFromConfig: done agentId=${route.agentId ?? "(none)"}`);
  } catch (err) {
    logger.error(
      `dispatchReplyFromConfig: error agentId=${route.agentId ?? "(none)"} err=${String(err)}`,
    );
    throw err;
  }
}
