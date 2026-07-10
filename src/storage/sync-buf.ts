import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "./state-dir.js";

function resolveAccountsDir(): string {
  return path.join(resolveStateDir(), "openclaw-cowlab", "accounts");
}

/**
 * Path to the persistent long-poll cursor file for an account.
 * Stored alongside account data: <stateDir>/openclaw-cowlab/accounts/{accountId}.sync.json
 */
export function getSyncBufFilePath(accountId: string): string {
  return path.join(resolveAccountsDir(), `${accountId}.sync.json`);
}

/** Legacy single-account path: agents/default/sessions/.openclaw-cowlab-sync/default.json. */
function getLegacySyncBufDefaultJsonPath(): string {
  return path.join(
    resolveStateDir(),
    "agents",
    "default",
    "sessions",
    ".openclaw-cowlab-sync",
    "default.json",
  );
}

function readSyncBufFile(filePath: string): string | undefined {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as { get_updates_buf?: string };
    if (typeof data.get_updates_buf === "string") {
      return data.get_updates_buf;
    }
  } catch {
    // file not found or invalid
  }
  return undefined;
}

/**
 * Load the persisted long-poll cursor.
 *
 * The on-disk file is keyed by `get_updates_buf` for compatibility with the
 * original schema, but the value itself is opaque to the plugin — it's
 * whatever the backend uses to remember "where we left off" (a watermark,
 * a server-issued token, etc.).
 *
 * Falls back to a legacy single-account path for old installs.
 */
export function loadGetUpdatesBuf(filePath: string): string | undefined {
  const value = readSyncBufFile(filePath);
  if (value !== undefined) return value;
  return readSyncBufFile(getLegacySyncBufDefaultJsonPath());
}

/**
 * Persist the long-poll cursor. Creates the parent dir if needed.
 */
export function saveGetUpdatesBuf(filePath: string, cursor: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ get_updates_buf: cursor }, null, 0), "utf-8");
}
