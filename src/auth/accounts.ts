import fs from "node:fs";
import path from "node:path";

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

import { resolveStateDir } from "../storage/state-dir.js";
import { resolveFrameworkAllowFromPath } from "./pairing.js";
import { logger } from "../util/logger.js";

/**
 * Fixed account id for the MVP. Multi-account is out of scope, but the
 * file layout (`accounts/<id>.json`) is preserved so a future expansion
 * can introduce real account ids without a data migration.
 */
export const SINGLE_ACCOUNT_ID = "main";

function resolveMyCowlabStateDir(): string {
  return path.join(resolveStateDir(), "openclaw-cowlab");
}

function resolveAccountsDir(): string {
  return path.join(resolveMyCowlabStateDir(), "accounts");
}

function resolveAccountPath(accountId: string): string {
  return path.join(resolveAccountsDir(), `${accountId}.json`);
}

// ---------------------------------------------------------------------------
// Account store (per-account credential files)
// ---------------------------------------------------------------------------

/** Persisted per-account data. */
export type MyCowlabAccountData = {
  token?: string;
  savedAt?: string;
  apiUrl?: string;
};

function readAccountFile(filePath: string): MyCowlabAccountData | null {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as MyCowlabAccountData;
    }
  } catch {
    // ignore
  }
  return null;
}

/** Load account data by ID. Returns null when no file exists. */
export function loadMyCowlabAccount(accountId: string): MyCowlabAccountData | null {
  return readAccountFile(resolveAccountPath(accountId));
}

/**
 * Persist account data (merges into existing file).
 * - token: overwritten when provided.
 * - apiUrl: stored when non-empty.
 */
export function saveMyCowlabAccount(
  accountId: string,
  update: { token?: string; apiUrl?: string },
): void {
  const dir = resolveAccountsDir();
  fs.mkdirSync(dir, { recursive: true });

  const existing = loadMyCowlabAccount(accountId) ?? {};

  const token = update.token?.trim() || existing.token;
  const apiUrl = update.apiUrl?.trim() || existing.apiUrl;

  const data: MyCowlabAccountData = {
    ...(token ? { token, savedAt: new Date().toISOString() } : {}),
    ...(apiUrl ? { apiUrl } : {}),
  };

  const filePath = resolveAccountPath(accountId);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort
  }
}

/**
 * Remove all files associated with an account:
 *   - accounts/{accountId}.json                  (credentials)
 *   - accounts/{accountId}.sync.json             (long-poll cursor)
 *   - accounts/{accountId}.context-tokens.json   (context tokens on disk)
 *   - credentials/openclaw-cowlab-{accountId}-allowFrom.json (authorized users)
 */
export function clearMyCowlabAccount(accountId: string): void {
  const dir = resolveAccountsDir();
  const accountFiles = [
    `${accountId}.json`,
    `${accountId}.sync.json`,
    `${accountId}.context-tokens.json`,
  ];
  for (const file of accountFiles) {
    try {
      fs.unlinkSync(path.join(dir, file));
    } catch {
      // ignore if not found
    }
  }
  try {
    fs.unlinkSync(resolveFrameworkAllowFromPath(accountId));
  } catch {
    // ignore if not found
  }
}

/**
 * Bump `channels.openclaw-cowlab.channelConfigUpdatedAt` in openclaw.json
 * so the gateway reloads config from disk after a login / account change.
 */
export async function triggerMyCowlabChannelReload(): Promise<void> {
  try {
    const { loadConfig, writeConfigFile } = await import("openclaw/plugin-sdk/config-runtime");
    const cfg = loadConfig();
    const channels = (cfg.channels ?? {}) as Record<string, unknown>;
    const existing = (channels["openclaw-cowlab"] as Record<string, unknown> | undefined) ?? {};
    const updated: OpenClawConfig = {
      ...cfg,
      channels: {
        ...channels,
        "openclaw-cowlab": {
          ...existing,
          channelConfigUpdatedAt: new Date().toISOString(),
        },
      },
    };
    await writeConfigFile(updated);
    logger.info("triggerMyCowlabChannelReload: wrote channel config to openclaw.json");
  } catch (err) {
    logger.warn(`triggerMyCowlabChannelReload: failed to update config: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Account resolution (merge config + stored credentials)
// ---------------------------------------------------------------------------

export type ResolvedMyCowlabAccount = {
  accountId: string;
  apiUrl: string;
  token?: string;
  enabled: boolean;
  /** true when a token has been loaded from the account file. */
  configured: boolean;
  name?: string;
};

type MyCowlabSectionConfig = {
  name?: string;
  enabled?: boolean;
  /** ISO 8601; bumped on each successful login to refresh gateway config from disk. */
  channelConfigUpdatedAt?: string;
};

/** List accountIds — MVP returns `["main"]` when the account file exists, else `[]`. */
export function listMyCowlabAccountIds(_cfg: OpenClawConfig): string[] {
  if (loadMyCowlabAccount(SINGLE_ACCOUNT_ID)) return [SINGLE_ACCOUNT_ID];
  return [];
}

/**
 * Resolve the (single) account by ID. Defaults to `"main"` when not provided.
 * Throws when `apiUrl` is missing from the config and the on-disk account.
 */
export function resolveMyCowlabAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedMyCowlabAccount {
  const id = (accountId?.trim() || SINGLE_ACCOUNT_ID);
  const section = cfg.channels?.["openclaw-cowlab"] as MyCowlabSectionConfig | undefined;

  const accountData = loadMyCowlabAccount(id);
  const token = accountData?.token?.trim() || undefined;
  const apiUrl = accountData?.apiUrl?.trim() || "";

  // The apiUrl may come from a saved account OR from the live config — the
  // caller (channel.ts) is expected to have called `loadStaticTokenConfig`
  // first and saved it. If we land here with no apiUrl, the account is
  // unconfigured; the caller will surface a "run login" error.
  if (!apiUrl) {
    return {
      accountId: id,
      apiUrl: "",
      token,
      enabled: section?.enabled !== false,
      configured: false,
      name: section?.name?.trim() || undefined,
    };
  }

  return {
    accountId: id,
    apiUrl,
    token,
    enabled: section?.enabled !== false,
    configured: Boolean(token),
    name: section?.name?.trim() || undefined,
  };
}
