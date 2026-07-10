import { logger } from "../util/logger.js";
import { sendMessageMyCowlab } from "./send.js";

/**
 * Send a plain-text error notice back to the user.
 * Fire-and-forget: errors are logged but never thrown, so callers stay unaffected.
 * No-op when contextToken is absent (we have no conversation reference to reply into).
 */
export async function sendMyCowlabErrorNotice(params: {
  to: string;
  contextToken: string | undefined;
  message: string;
  apiUrl: string;
  token?: string;
  errLog: (m: string) => void;
}): Promise<void> {
  if (!params.contextToken) {
    logger.warn(`sendMyCowlabErrorNotice: no contextToken for to=${params.to}, sending without context`);
  }
  try {
    await sendMessageMyCowlab({
      to: params.to,
      text: params.message,
      opts: { apiUrl: params.apiUrl, token: params.token, contextToken: params.contextToken },
    });
    logger.debug(`sendMyCowlabErrorNotice: sent to=${params.to}`);
  } catch (err) {
    params.errLog(`[cowlab] sendMyCowlabErrorNotice failed to=${params.to}: ${String(err)}`);
  }
}
