import { sendMessage as sendMessageApi } from "../api/client.js";
import { logger } from "../util/logger.js";
import { generateId } from "../util/random.js";

export { StreamingMarkdownFilter } from "./markdown-filter.js";

/**
 * Send a plain text message downstream.
 *
 * The `clientId` is generated locally and returned as the synthetic
 * `messageId` — the backend may assign its own id but for the MVP the
 * local id is sufficient for tracing and dedup on the client side.
 */
export async function sendMessageMyCowlab(params: {
  to: string;
  text: string;
  opts: { apiUrl: string; token?: string; contextToken?: string };
}): Promise<{ messageId: string }> {
  const { to, text, opts } = params;
  const clientId = generateId("openclaw-cowlab");
  try {
    const resp = await sendMessageApi({
      apiUrl: opts.apiUrl,
      token: opts.token,
      to,
      text,
      contextToken: opts.contextToken,
    });
    return { messageId: resp.messageId || clientId };
  } catch (err) {
    logger.error(`sendMessageMyCowlab: failed to=${to} clientId=${clientId} err=${String(err)}`);
    throw err;
  }
}
