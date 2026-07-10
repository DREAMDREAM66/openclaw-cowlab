# openclaw-cowlab

[English](README.md) · [中文](README.zh.md)

一个 [OpenClaw](https://docs.openclaw.ai) 频道插件，通过一个轻量级 HTTP 后端，把**你自己的聊天应用**桥接到 OpenClaw agent gateway。

> 从 `@tencent-weixin/openclaw-weixin` fork 而来，所有微信相关代码已被替换。OpenClaw 框架粘合代码（channel wiring、message processing、storage、hooks）原样保留。

## 它做什么

- **入站（Inbound）**：长轮询（long-poll）你的后端获取新消息，然后分发给配置好的 OpenClaw agent。
- **出站（Outbound）**：当 agent 回复时，把文本 POST 回你的后端。
- **认证（Auth）**：从配置文件（或环境变量）读取静态 bearer token。无需扫码登录，无需 session 续期。

## 状态

MVP / 纯文本。尚不支持图片、文件、语音、视频。参见下方 [MVP 不在范围内](#mvp-不在范围内)。

## 后端协议

你的后端必须暴露两个端点，JSON over HTTP，header 为 `Authorization: Bearer <token>`。

### `GET /v1/messages/poll?timeout=<sec>&cursor=<opaque>`

长轮询新消息。请求最长保持 `timeout` 秒，然后返回。

响应：

```json
{
  "messages": [
    { "id": "msg-1", "from": "user-alice", "text": "Hi", "timestamp": 1700000000000, "contextToken": "ctx-abc" }
  ],
  "cursor": "next-cursor-value"
}
```

- `cursor` 对插件不透明 —— 由后端自行定义含义（例如 last-id、watermark、JWT）。插件原样存储你返回的值，下次轮询时再发回。
- 轮询超时但没有新消息时，返回 `{ "messages": [], "cursor": "<unchanged>" }`。
- `contextToken` 会在回复时被原样带回，便于你的后端做关联；插件把它当作不透明字符串处理。

### `POST /v1/messages`

向某个用户发送一条文本消息。

请求：

```json
{ "to": "user-alice", "text": "Hello back", "contextToken": "ctx-abc" }
```

响应：`{ "messageId": "msg-456" }`（插件用来做追踪；本地的合成 id 作为兜底）。

## 配置

在 `openclaw.json` 中：

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

或者用环境变量（覆盖配置文件）：

```
OPENCLAW_COWLAB_API_URL=https://your-backend.example.com
OPENCLAW_COWLAB_API_TOKEN=your-secret-token
```

然后运行：

```bash
openclaw channels login --channel openclaw-cowlab
openclaw channels start  --channel openclaw-cowlab
```

## 本地开发 / 测试

仓库自带一个实现上述协议的 mock 后端，以及一个跑完整往返流程的集成测试。

```bash
# 安装
npm install

# 类型检查 + 测试
npm run typecheck
npm test

# 构建
npm run build

# 在 :4001 跑 mock 后端（需要 `npx tsx`，首次运行时会懒安装）
npx tsx tests/mock-backend/server.ts 4001
```

mock 后端额外暴露了一些仅供测试的端点：

- `POST /v1/test/inject` —— 往入站队列里塞一条消息
- `GET  /v1/test/outbound` —— 列出已收到的出站消息
- `POST /v1/test/reset` —— 清空所有队列

## MVP 不在范围内

- 媒体（图片、文件、语音、视频）—— `outbound.sendMedia` 直接抛错。
- 多账号 —— 单一固定账号 id `"main"`。
- 正在输入（typing indicators）—— 没有等价物；入站管道不会调用任何东西。
- Session 失效熔断器 —— 依赖 HTTP 错误 → 标准退避。
- 扫码登录 —— 已被静态 token 认证取代。

如果你真实的后端接口形状不同，只需改 `src/api/client.ts` 一个文件。

## 项目结构

```
src/
  api/
    client.ts          HTTP 客户端（getUpdates + sendMessage）
    types.ts           协议类型（MyCowlabMessage, GetUpdatesResp, SendMessageReq/Resp）
  auth/
    accounts.ts        单账号持久化（<stateDir>/openclaw-cowlab/accounts/main.json）
    login.ts           静态 token 配置加载
    pairing.ts         框架 pairing 存储（registerUserInFrameworkStore, readFrameworkAllowFromList）
  config/
    config-schema.ts   channel 配置段的 zod schema
  messaging/
    inbound.ts         消息上下文转换 + context-token 存储
    outbound-hooks.ts  message_sending / message_sent hook 适配器
    process-message.ts 入站分发器（framework glue）
    send.ts            sendMessageMyCowlab
    markdown-filter.ts 流式 markdown → 纯文本
    error-notice.ts    面向用户的错误提示
    debug-mode.ts      per-account debug mode 开关（落盘持久化）
    slash-commands.ts  /echo, /toggle-debug
  monitor/
    monitor.ts         长轮询循环，含退避 + cursor 持久化
  storage/
    state-dir.ts       resolveStateDir() —— 环境变量覆盖链
    sync-buf.ts        get_updates_buf (cursor) load/save
  util/
    logger.ts          JSON-line logger
    redact.ts          redactBody / redactUrl / redactToken
    random.ts          generateId
  channel.ts           ChannelPlugin<ResolvedMyCowlabAccount> 装配
  compat.ts            宿主版本兼容性检查（assertHostCompatibility）
index.ts               插件入口（通过 api.registerChannel 注册）
tests/
  mock-backend/server.ts  内存版 mock 后端，用于手动 / 集成测试
  integration.test.ts     通过 mock 跑端到端往返
```

## 落盘状态

```
<stateDir>/openclaw-cowlab/
  accounts/
    main.json             # { token, apiUrl, savedAt }
    main.sync.json        # 长轮询 cursor
    main.context-tokens.json  # { "<userId>": "<contextToken>" }
```

`<stateDir>` 解析顺序：`OPENCLAW_STATE_DIR` → `CLAWDBOT_STATE_DIR` → `~/.openclaw`。

## 致谢

本项目是 [`@tencent-weixin/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin) 的 fork，原项目使用 MIT 协议。OpenClaw 框架粘合代码（channel wiring、message processing、storage、hooks）从上游原样保留；只有微信 ilink 协议被替换成了通用 HTTP bridge。

感谢腾讯为上游所做的工作。

## 许可证

MIT —— 详见 [LICENSE](./LICENSE)。

Copyright (c) 2026 Tencent (original `openclaw-weixin`)  
Copyright (c) 2026 DREAMDREAM66 (`openclaw-cowlab` fork)
