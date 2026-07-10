/**
 * Minimal mock backend for the openclaw-cowlab plugin.
 *
 * Implements the contract from the plan:
 *   GET  /v1/messages/poll?timeout=N&cursor=X   long-poll, returns queued messages
 *   POST /v1/messages                            receives outbound message from plugin
 *
 * Test-only helpers:
 *   POST /v1/test/inject              push a message into the inbound queue
 *   GET  /v1/test/outbound            list of received outbound messages
 *   POST /v1/test/reset               clear all queues
 *
 * Run standalone:
 *   node --import tsx tests/mock-backend/server.ts [port=4001]
 *
 * Used by tests/integration.test.ts to exercise the plugin's full round-trip.
 */

import http from "node:http";
import { randomUUID } from "node:crypto";

type InboundMessage = {
  id: string;
  from: string;
  text: string;
  timestamp: number;
  contextToken?: string;
};

type OutboundMessage = {
  to: string;
  text: string;
  contextToken?: string;
  receivedAt: number;
};

export type MockBackendState = {
  port: number;
  server: http.Server;
  inject: (msg: Omit<InboundMessage, "id" | "timestamp">) => string;
  getOutbound: () => OutboundMessage[];
  reset: () => void;
  close: () => Promise<void>;
  baseUrl: string;
};

export function startMockBackend(port = 0): Promise<MockBackendState> {
  const queue: InboundMessage[] = [];
  const waiters: Array<(msgs: InboundMessage[]) => void> = [];
  const outbound: OutboundMessage[] = [];

  const server = http.createServer((req, res) => {
    // CORS-light: allow everything from the plugin process.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");

    const sendJson = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    // -- Outbound send from plugin
    if (req.method === "POST" && url.pathname === "/v1/messages") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          const body = JSON.parse(raw) as { to: string; text: string; contextToken?: string };
          if (typeof body.to !== "string" || typeof body.text !== "string") {
            return sendJson(400, { error: "invalid body" });
          }
          outbound.push({
            to: body.to,
            text: body.text,
            contextToken: body.contextToken,
            receivedAt: Date.now(),
          });
          sendJson(200, { messageId: `mock-${randomUUID()}` });
        } catch (err) {
          sendJson(400, { error: String(err) });
        }
      });
      return;
    }

    // -- Inbound long-poll
    if (req.method === "GET" && url.pathname === "/v1/messages/poll") {
      const timeoutSec = Math.max(1, Number(url.searchParams.get("timeout") ?? "35"));
      const cursor = url.searchParams.get("cursor") ?? "";

      const reply = (msgs: InboundMessage[]) => {
        // The mock backend hands out a fresh cursor each time. The plugin
        // stores whatever it receives, so the next poll won't replay these
        // messages. In a real backend the cursor would be a watermark.
        sendJson(200, {
          messages: msgs,
          cursor: `${cursor || "0"}-${Date.now()}-${msgs.length}`,
        });
      };

      if (queue.length > 0) {
        const batch = queue.splice(0, queue.length);
        return reply(batch);
      }

      // No messages — wait up to timeoutSec, but cap at 5s so the test can
      // exercise abort behaviour quickly.
      const waitMs = Math.min(timeoutSec * 1000, 5_000);
      const waiter: (msgs: InboundMessage[]) => void = (msgs) => reply(msgs);
      waiters.push(waiter);
      const t = setTimeout(() => {
        const idx = waiters.indexOf(waiter);
        if (idx !== -1) waiters.splice(idx, 1);
        reply([]);
      }, waitMs);
      req.on("close", () => {
        clearTimeout(t);
        const idx = waiters.indexOf(waiter);
        if (idx !== -1) waiters.splice(idx, 1);
      });
      return;
    }

    // -- Test-only: inject a message into the queue
    if (req.method === "POST" && url.pathname === "/v1/test/inject") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          const body = JSON.parse(raw) as Partial<InboundMessage>;
          if (typeof body.from !== "string" || typeof body.text !== "string") {
            return sendJson(400, { error: "from and text are required" });
          }
          const msg: InboundMessage = {
            id: body.id ?? `mock-${randomUUID()}`,
            from: body.from,
            text: body.text,
            timestamp: body.timestamp ?? Date.now(),
            contextToken: body.contextToken,
          };
          queue.push(msg);
          // Wake one waiter immediately.
          const waiter = waiters.shift();
          if (waiter) {
            const batch = queue.splice(0, queue.length);
            waiter(batch);
          }
          sendJson(200, { id: msg.id });
        } catch (err) {
          sendJson(400, { error: String(err) });
        }
      });
      return;
    }

    // -- Test-only: list received outbound messages
    if (req.method === "GET" && url.pathname === "/v1/test/outbound") {
      return sendJson(200, { messages: outbound });
    }

    // -- Test-only: reset queues
    if (req.method === "POST" && url.pathname === "/v1/test/reset") {
      queue.length = 0;
      outbound.length = 0;
      return sendJson(200, { ok: true });
    }

    sendJson(404, { error: "not found" });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to bind"));
        return;
      }
      const state: MockBackendState = {
        port: address.port,
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
        inject: (msg) => {
          const full: InboundMessage = {
            id: `mock-${randomUUID()}`,
            timestamp: Date.now(),
            ...msg,
          };
          queue.push(full);
          const waiter = waiters.shift();
          if (waiter) {
            const batch = queue.splice(0, queue.length);
            waiter(batch);
          }
          return full.id;
        },
        getOutbound: () => [...outbound],
        reset: () => {
          queue.length = 0;
          outbound.length = 0;
        },
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      };
      resolve(state);
    });
  });
}

// Run standalone: `node --import tsx tests/mock-backend/server.ts [port]`
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 4001);
  startMockBackend(port).then((s) => {
    console.log(`Mock backend listening on ${s.baseUrl}`);
  });
}
