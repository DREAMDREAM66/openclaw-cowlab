import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

import { logger } from "../util/logger.js";

/**
 * Channel section config for openclaw-cowlab.
 *
 * `apiUrl` and `apiToken` are the only required fields. The token is what
 * the backend uses to identify the bot (sent as `Authorization: Bearer ...`).
 *
 * `apiUrl` may be omitted from the live config; in that case it is taken
 * from the saved account file. For `loadStaticTokenConfig` we require both
 * to be present in the config — the saved account file is the result of a
 * previous login, not the source of truth for new logins.
 */
export type MyCowlabSectionConfig = {
  apiUrl?: string;
  apiToken?: string;
  name?: string;
  enabled?: boolean;
  channelConfigUpdatedAt?: string;
  [k: string]: unknown;
};

const CHANNEL_ID = "openclaw-cowlab";

/**
 * Read the channel section from the openclaw config.
 * Throws a descriptive error if the section is missing entirely.
 */
export function getMyCowlabSection(cfg: OpenClawConfig): MyCowlabSectionConfig {
  const section = cfg.channels?.[CHANNEL_ID] as MyCowlabSectionConfig | undefined;
  if (!section) {
    throw new Error(
      `cowlab: missing config section "channels.${CHANNEL_ID}" — ` +
        `add an entry with { apiUrl, apiToken } to your openclaw.json`,
    );
  }
  return section;
}

/**
 * Validate the static-token login config and return `{ apiUrl, token }`.
 *
 * Environment-variable fallbacks (handy for containerized deploys):
 *   - `OPENCLAW_COWLAB_API_URL`   overrides `channels.openclaw-cowlab.apiUrl`
 *   - `OPENCLAW_COWLAB_API_TOKEN` overrides `channels.openclaw-cowlab.apiToken`
 *
 * Throws a descriptive error if either is missing or empty.
 */
export function loadStaticTokenConfig(cfg: OpenClawConfig): { apiUrl: string; token: string } {
  const section = getMyCowlabSection(cfg);

  const apiUrl =
    process.env.OPENCLAW_COWLAB_API_URL?.trim() || section.apiUrl?.trim() || "";
  const token =
    process.env.OPENCLAW_COWLAB_API_TOKEN?.trim() || section.apiToken?.trim() || "";

  if (!apiUrl) {
    throw new Error(
      `cowlab: apiUrl is required — set channels.openclaw-cowlab.apiUrl ` +
        `or the OPENCLAW_COWLAB_API_URL environment variable`,
    );
  }
  if (!token) {
    throw new Error(
      `cowlab: apiToken is required — set channels.openclaw-cowlab.apiToken ` +
        `or the OPENCLAW_COWLAB_API_TOKEN environment variable`,
    );
  }

  // Light validation — the user will hit a clearer error on the first poll
  // if the URL is otherwise malformed.
  if (!apiUrl.startsWith("http://") && !apiUrl.startsWith("https://")) {
    logger.warn(`loadStaticTokenConfig: apiUrl does not look like an http(s) URL: ${apiUrl}`);
  }

  return { apiUrl, token };
}
