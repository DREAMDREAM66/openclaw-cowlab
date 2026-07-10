import fs from "node:fs";
import path from "node:path";

import { logger } from "../util/logger.js";
import { generateId } from "../util/random.js";
import { resolveStateDir } from "../storage/state-dir.js";

import type { MyCowlabMessage } from "../api/types.js";

// ---------------------------------------------------------------------------
// Context token store (in-process cache + disk persistence)
// ---------------------------------------------------------------------------

/**
 * contextToken is whatever the backend uses to correlate a reply with the
 * inbound that triggered it. The in-memory map is the primary lookup; a
 * disk-backed file per account ensures tokens survive gateway restarts.
 */
const contextTokenStore = new Map<string, string>();

function contextTokenKey(accountId: string, userId: string): string {
  return `${accountId}:${userId}`;
}

function resolveContextTokenFilePath(accountId: string): string {
  return path.join(
    resolveStateDir(),
    "openclaw-cowlab",
    "accounts",
    `${accountId}.context-tokens.json`,
  );
}

/** Persist all context tokens for a given account to disk. */
function persistContextTokens(accountId: string): void {
  const prefix = `${accountId}:`;
  const tokens: Record<string, string> = {};
  for (const [k, v] of contextTokenStore) {
    if (k.startsWith(prefix)) {
      tokens[k.slice(prefix.length)] = v;
    }
  }
  const filePath = resolveContextTokenFilePath(accountId);
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(tokens, null, 0), "utf-8");
  } catch (err) {
    logger.warn(`persistContextTokens: failed to write ${filePath}: ${String(err)}`);
  }
}

/**
 * Restore persisted context tokens for an account into the in-memory map.
 * Called once during gateway startAccount to survive restarts.
 */
export function restoreContextTokens(accountId: string): void {
  const filePath = resolveContextTokenFilePath(accountId);
  try {
    if (!fs.existsSync(filePath)) return;
    const raw = fs.readFileSync(filePath, "utf-8");
    const tokens = JSON.parse(raw) as Record<string, string>;
    let count = 0;
    for (const [userId, token] of Object.entries(tokens)) {
      if (typeof token === "string" && token) {
        contextTokenStore.set(contextTokenKey(accountId, userId), token);
        count++;
      }
    }
    logger.info(`restoreContextTokens: restored ${count} tokens for account=${accountId}`);
  } catch (err) {
    logger.warn(`restoreContextTokens: failed to read ${filePath}: ${String(err)}`);
  }
}

/** Remove all context tokens for a given account (memory + disk). */
export function clearContextTokensForAccount(accountId: string): void {
  const prefix = `${accountId}:`;
  for (const k of [...contextTokenStore.keys()]) {
    if (k.startsWith(prefix)) {
      contextTokenStore.delete(k);
    }
  }
  const filePath = resolveContextTokenFilePath(accountId);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    logger.warn(`clearContextTokensForAccount: failed to remove ${filePath}: ${String(err)}`);
  }
  logger.info(`clearContextTokensForAccount: cleared tokens for account=${accountId}`);
}

/** Store a context token for a given account+user pair (memory + disk). */
export function setContextToken(accountId: string, userId: string, token: string): void {
  const k = contextTokenKey(accountId, userId);
  logger.debug(`setContextToken: key=${k}`);
  contextTokenStore.set(k, token);
  persistContextTokens(accountId);
}

/** Retrieve the cached context token for a given account+user pair. */
export function getContextToken(accountId: string, userId: string): string | undefined {
  const k = contextTokenKey(accountId, userId);
  const val = contextTokenStore.get(k);
  logger.debug(
    `getContextToken: key=${k} found=${val !== undefined} storeSize=${contextTokenStore.size}`,
  );
  return val;
}

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

function generateMessageSid(): string {
  return generateId("openclaw-cowlab");
}

/** Inbound context passed to the OpenClaw core pipeline (matches MsgContext shape). */
export type MyCowlabMsgContext = {
  Body: string;
  From: string;
  To: string;
  AccountId: string;
  OriginatingChannel: "openclaw-cowlab";
  OriginatingTo: string;
  MessageSid: string;
  Timestamp?: number;
  Provider: "openclaw-cowlab";
  ChatType: "direct";
  /** Set by monitor after resolveAgentRoute so dispatchReplyFromConfig uses the correct session. */
  SessionKey?: string;
  context_token?: string;
  /** Raw message body for framework command authorization. */
  CommandBody?: string;
  /** Whether the sender is authorized to execute slash commands. */
  CommandAuthorized?: boolean;
};

/**
 * Convert a MyCowlabMessage from the long-poll to the inbound MsgContext for
 * the core pipeline. The MVP does not handle media, so no MediaPath is set.
 */
export function myAppMessageToMsgContext(
  msg: MyCowlabMessage,
  accountId: string,
): MyCowlabMsgContext {
  const from = msg.from ?? "";
  const ctx: MyCowlabMsgContext = {
    Body: msg.text ?? "",
    From: from,
    To: from,
    AccountId: accountId,
    OriginatingChannel: "openclaw-cowlab",
    OriginatingTo: from,
    MessageSid: generateMessageSid(),
    Timestamp: msg.timestamp,
    Provider: "openclaw-cowlab",
    ChatType: "direct",
  };
  if (msg.contextToken) {
    ctx.context_token = msg.contextToken;
  }
  return ctx;
}

/** Extract the context_token from an inbound MyCowlabMsgContext. */
export function getContextTokenFromMsgContext(ctx: MyCowlabMsgContext): string | undefined {
  return ctx.context_token;
}
