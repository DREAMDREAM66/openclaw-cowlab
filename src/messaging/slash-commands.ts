/**
 * MyCowlab slash command handler.
 *
 * Supported commands:
 * - /echo <message>         reply directly (no AI) with a channel-latency block
 * - /toggle-debug           toggle debug mode (no-op for MVP; see debug-mode.ts)
 */
import { logger } from "../util/logger.js";

import { toggleDebugMode } from "./debug-mode.js";
import { sendMessageMyCowlab } from "./send.js";

export interface SlashCommandResult {
  /** Whether the message was handled as a slash command (true = skip AI pipeline). */
  handled: boolean;
}

export interface SlashCommandContext {
  to: string;
  contextToken?: string;
  apiUrl: string;
  token?: string;
  accountId: string;
  log: (msg: string) => void;
  errLog: (msg: string) => void;
}

async function sendReply(ctx: SlashCommandContext, text: string): Promise<void> {
  await sendMessageMyCowlab({
    to: ctx.to,
    text,
    opts: { apiUrl: ctx.apiUrl, token: ctx.token, contextToken: ctx.contextToken },
  });
}

async function handleEcho(
  ctx: SlashCommandContext,
  args: string,
  receivedAt: number,
  eventTimestamp?: number,
): Promise<void> {
  const message = args.trim();
  if (message) {
    await sendReply(ctx, message);
  }
  const eventTs = eventTimestamp ?? 0;
  const platformDelay = eventTs > 0 ? `${receivedAt - eventTs}ms` : "N/A";
  const timing = [
    "⏱ 通道耗时",
    `├ 事件时间: ${eventTs > 0 ? new Date(eventTs).toISOString() : "N/A"}`,
    `├ 平台→插件: ${platformDelay}`,
    `└ 插件处理: ${Date.now() - receivedAt}ms`,
  ].join("\n");
  await sendReply(ctx, timing);
}

/**
 * Try to handle a slash command.
 *
 * @returns handled=true means the message was handled as a command and the AI pipeline should be skipped.
 */
export async function handleSlashCommand(
  content: string,
  ctx: SlashCommandContext,
  receivedAt: number,
  eventTimestamp?: number,
): Promise<SlashCommandResult> {
  const trimmed = content.trim();
  if (!trimmed.startsWith("/")) {
    return { handled: false };
  }

  const spaceIdx = trimmed.indexOf(" ");
  const command = spaceIdx === -1 ? trimmed.toLowerCase() : trimmed.slice(0, spaceIdx).toLowerCase();
  const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);

  logger.info(`[cowlab] Slash command: ${command}, args: ${args.slice(0, 50)}`);

  try {
    switch (command) {
      case "/echo":
        await handleEcho(ctx, args, receivedAt, eventTimestamp);
        return { handled: true };
      case "/toggle-debug": {
        const enabled = toggleDebugMode(ctx.accountId);
        await sendReply(ctx, enabled ? "Debug 模式已开启" : "Debug 模式已关闭");
        return { handled: true };
      }
      default:
        return { handled: false };
    }
  } catch (err) {
    logger.error(`[cowlab] Slash command error: ${String(err)}`);
    try {
      await sendReply(ctx, `❌ 指令执行失败: ${String(err).slice(0, 200)}`);
    } catch {
      // sending the error message also failed; just log
    }
    return { handled: true };
  }
}
