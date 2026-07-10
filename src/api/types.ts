/**
 * Wire types for the user's chat-app HTTP backend.
 *
 * The plugin treats the backend as a thin transport: it long-polls for new
 * messages and POSTs outbound messages. Both sides are JSON over HTTP, with
 * a Bearer token for auth (see `src/api/client.ts`).
 *
 * The `contextToken` field is opaque to the plugin — it is whatever the
 * backend uses to correlate a reply with the inbound that triggered it.
 * The plugin echoes it verbatim on outbound sends and caches it per
 * (account, user) pair so a fresh conversation can still be replied to.
 */

/** One inbound message returned by the long-poll. */
export interface MyCowlabMessage {
  /** Backend-assigned unique id; used for deduplication. */
  id: string;
  /** Sender identifier (the chat app's user id, e.g. an opaque string). */
  from: string;
  /** Plain-text body. The MVP does not support media. */
  text: string;
  /** Wall-clock timestamp in ms; informational only. */
  timestamp?: number;
  /** Opaque correlation token; echo back on the reply. */
  contextToken?: string;
}

/** Long-poll response shape. */
export interface GetUpdatesResp {
  /** New messages since the cursor; empty array on timeout. */
  messages: MyCowlabMessage[];
  /** Opaque cursor for the next poll. Backend-defined semantics. */
  cursor: string;
}

/** Outbound text send. */
export interface SendMessageReq {
  to: string;
  text: string;
  contextToken?: string;
}

export interface SendMessageResp {
  messageId: string;
}
