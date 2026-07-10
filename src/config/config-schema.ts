import { z } from "zod";

/**
 * Top-level cowlab config schema.
 *
 * `apiUrl` and `apiToken` are required for the plugin to operate. The
 * token is also re-persisted in the account file by `auth.login`, but
 * the source of truth for a fresh login is this config section.
 *
 * Either:
 *   - Set them in `openclaw.json` under `channels.openclaw-cowlab`
 *   - Set them via env vars `OPENCLAW_COWLAB_API_URL` / `OPENCLAW_COWLAB_API_TOKEN`
 */
export const MyCowlabConfigSchema = z.object({
  apiUrl: z.string().min(1).optional(),
  apiToken: z.string().min(1).optional(),
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  /** ISO 8601; bumped on each successful login to refresh gateway config from disk. */
  channelConfigUpdatedAt: z.string().optional(),
});
