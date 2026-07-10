# openclaw-cowlab

An [OpenClaw](https://docs.openclaw.ai) channel plugin that bridges **your own chat app** (via a small HTTP backend) to the OpenClaw agent gateway.

> Forked from `@tencent-weixin/openclaw-weixin` with all WeChat-specific code replaced. The OpenClaw framework glue (channel wiring, message processing, storage, hooks) is carried over verbatim.

## What it does

- **Inbound**: long-polls your backend for new messages, then dispatches them to the configured OpenClaw agent.
- **Outbound**: when the agent replies, POSTs the text back to your backend.
- **Auth**: static bearer token from your config (or env var). No QR login, no session refresh dance.

## Status

MVP / text-only. No images, files, voice, or video yet. See [Out of scope](#out-of-scope) below.

## Backend contract

Your backend must expose two endpoints, JSON over HTTP, with `Authorization: Bearer <token>`.

### `GET /v1/messages/poll?timeout=<sec>&cursor=<opaque>`

Long-poll for new messages. Hold the request up to `timeout` seconds, then return.

Response:
```json
{
  "messages": [
    { "id": "msg-1", "from": "user-alice", "text": "Hi", "timestamp": 1700000000000, "contextToken": "ctx-abc" }
  ],
  "cursor": "next-cursor-value"
}
```

- `cursor` is opaque to the plugin — the backend defines its meaning (e.g. last-id, watermark, JWT). The plugin stores whatever you return and sends it back on the next poll.
- On timeout with no new messages, return `{ "messages": [], "cursor": "<unchanged>" }`.
- `contextToken` is echoed back on the reply so your backend can correlate; treat it as opaque.

### `POST /v1/messages`

Send a text message to a user.

Request:
```json
{ "to": "user-alice", "text": "Hello back", "contextToken": "ctx-abc" }
```

Response: `{ "messageId": "msg-456" }` (the plugin uses this for tracing; the local synthetic id is used as a fallback).

## Configuration

In your `openclaw.json`:

```json
{
  "channels": {
    "openclaw-cowlab": {
      "apiUrl": "https://your-backend.example.com",
      "apiToken": "your-secret-token"
    }
  }
}
```

Or via env vars (override the config):

```
OPENCLAW_COWLAB_API_URL=https://your-backend.example.com
OPENCLAW_COWLAB_API_TOKEN=your-secret-token
```

Then run:

```bash
openclaw channels login --channel openclaw-cowlab
openclaw channels start  --channel openclaw-cowlab
```

## Local development / testing

The repo ships with a mock backend that implements the contract above, plus an integration test that drives the full round-trip.

```bash
# Install
npm install

# Typecheck + tests
npm run typecheck
npm test

# Build
npm run build

# Run the mock backend on :4001 (requires `npx tsx` — installed lazily on first run)
npx tsx tests/mock-backend/server.ts 4001
```

The mock backend also exposes test-only endpoints:
- `POST /v1/test/inject` — push a message into the inbound queue
- `GET  /v1/test/outbound` — list received outbound messages
- `POST /v1/test/reset`   — clear all queues

## Out of scope (MVP)

- Media (images, files, voice, video) — `outbound.sendMedia` throws.
- Multi-account — single fixed account id `"main"`.
- Typing indicators — no equivalent; the inbound pipeline doesn't call anything.
- Session-expired circuit breaker — rely on HTTP error → standard backoff.
- QR login — replaced by static token auth.

If your real backend already has a different shape, only `src/api/client.ts` needs to change.

## Project layout

```
src/
  api/
    client.ts          the HTTP client (getUpdates + sendMessage)
    types.ts           wire types (MyCowlabMessage, GetUpdatesResp, SendMessageReq/Resp)
  auth/
    accounts.ts        single-account persistence (<stateDir>/openclaw-cowlab/accounts/main.json)
    login.ts           static-token config loader
  config/
    config-schema.ts   zod schema for the channel section
  messaging/
    inbound.ts         message-context conversion + context-token store
    outbound-hooks.ts  message_sending / message_sent hook adapters
    process-message.ts inbound dispatcher (framework glue)
    send.ts            sendMessageMyCowlab
    markdown-filter.ts streaming markdown → plain text
    error-notice.ts    user-facing error notice
    slash-commands.ts  /echo, /toggle-debug
  monitor/
    monitor.ts         long-poll loop with backoff + cursor persistence
  storage/
    state-dir.ts       resolveStateDir() — env-var override chain
    sync-buf.ts        get_updates_buf (cursor) load/save
  util/
    logger.ts          JSON-line logger
    redact.ts          redactBody / redactUrl / redactToken
    agent.ts           resolveAgentWorkspaceDir / resolveMatchedAgentId
    random.ts          generateId
  channel.ts           the ChannelPlugin<ResolvedMyCowlabAccount> wiring
index.ts               plugin entry (registered via api.registerChannel)
tests/
  mock-backend/server.ts  in-memory mock backend for manual / integration tests
  integration.test.ts     end-to-end round-trip via the mock
```

## On-disk state

```
<stateDir>/openclaw-cowlab/
  accounts/
    main.json             # { token, apiUrl, savedAt }
    main.sync.json        # long-poll cursor
    main.context-tokens.json  # { "<userId>": "<contextToken>" }
```

`<stateDir>` resolves to `OPENCLAW_STATE_DIR` → `CLAWDBOT_STATE_DIR` → `~/.openclaw`.

## Acknowledgments

This project is a fork of [`@tencent-weixin/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin), licensed under MIT. The OpenClaw framework glue (channel wiring, message processing, storage, hooks) is carried over verbatim from the upstream; only the WeChat ilink protocol has been replaced with a generic HTTP bridge.

Thanks to Tencent for the upstream work that made this project possible.

## License

MIT — see [LICENSE](./LICENSE).

Copyright (c) 2026 Tencent (original `openclaw-weixin`)  
Copyright (c) 2026 DREAMDREAM66 (`openclaw-cowlab` fork)
