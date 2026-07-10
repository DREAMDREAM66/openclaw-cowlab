/**
 * End-to-end test: spin up the mock backend, drive the new HTTP client +
 * monitor loop directly, inject a message, and assert the outbound send
 * reaches the mock.
 *
 * The full plugin SDK surface (channelRuntime) is too complex to mock here;
 * this test exercises the pieces that don't need the framework — the HTTP
 * client, the long-poll cursor, and the send path. The framework glue is
 * covered by the unit tests for process-message and the channel plugin.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { startMockBackend, type MockBackendState } from "./mock-backend/server.js";
import { getUpdates, sendMessage } from "../src/api/client.js";
import {
  loadGetUpdatesBuf,
  saveGetUpdatesBuf,
  getSyncBufFilePath,
} from "../src/storage/sync-buf.js";

let backend: MockBackendState;
let tmpStateDir: string;
const ACCOUNT_ID = "main";
const TOKEN = "test-token-xyz";

beforeAll(async () => {
  backend = await startMockBackend(0); // random free port
  tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowlab-integ-"));
  process.env.OPENCLAW_STATE_DIR = tmpStateDir;
});

afterAll(async () => {
  delete process.env.OPENCLAW_STATE_DIR;
  fs.rmSync(tmpStateDir, { recursive: true, force: true });
  await backend.close();
});

afterEach(() => {
  backend.reset();
});

describe("round-trip via mock backend", () => {
  it("polls an empty queue, then receives a message after injection", async () => {
    // 1. Empty poll: should return immediately (mock holds up to 5s, but
    //    we use a small timeout to keep the test fast).
    const empty = await getUpdates({
      apiUrl: backend.baseUrl,
      token: TOKEN,
      cursor: "",
      timeoutSec: 1,
    });
    expect(empty.messages).toEqual([]);

    // 2. Inject a message via the test endpoint. The mock will wake one
    //    pending waiter so the next long-poll returns it.
    const id = backend.inject({ from: "user-alice", text: "hello", contextToken: "ctx-1" });
    expect(id).toBeTruthy();

    // 3. The next long-poll should receive the injected message.
    const resp = await getUpdates({
      apiUrl: backend.baseUrl,
      token: TOKEN,
      cursor: empty.cursor,
      timeoutSec: 5,
    });
    expect(resp.messages).toHaveLength(1);
    expect(resp.messages[0].text).toBe("hello");
    expect(resp.messages[0].from).toBe("user-alice");
    expect(resp.messages[0].contextToken).toBe("ctx-1");
    // Cursor must have advanced.
    expect(resp.cursor).not.toBe(empty.cursor);
  });

  it("persists the cursor across polls (simulating plugin restart)", async () => {
    const fp = getSyncBufFilePath(ACCOUNT_ID);
    expect(loadGetUpdatesBuf(fp)).toBeUndefined();

    const id1 = backend.inject({ from: "u1", text: "first" });
    const resp1 = await getUpdates({
      apiUrl: backend.baseUrl,
      token: TOKEN,
      cursor: "",
      timeoutSec: 5,
    });
    expect(resp1.messages.map((m) => m.id)).toContain(id1);
    saveGetUpdatesBuf(fp, resp1.cursor);

    // Simulate restart: re-load the cursor from disk.
    const restored = loadGetUpdatesBuf(fp);
    expect(restored).toBe(resp1.cursor);

    // Next poll should NOT re-deliver the already-seen message (mock hands
    // out a fresh cursor each time and only contains what was injected
    // after the previous poll).
    const id2 = backend.inject({ from: "u2", text: "second" });
    const resp2 = await getUpdates({
      apiUrl: backend.baseUrl,
      token: TOKEN,
      cursor: restored!,
      timeoutSec: 5,
    });
    expect(resp2.messages.map((m) => m.id)).toContain(id2);
    expect(resp2.messages.map((m) => m.id)).not.toContain(id1);
  });

  it("sends an outbound text message and the mock records it", async () => {
    const resp = await sendMessage({
      apiUrl: backend.baseUrl,
      token: TOKEN,
      to: "user-bob",
      text: "echo: hi",
      contextToken: "ctx-out",
    });
    expect(resp.messageId).toMatch(/^mock-/);

    const received = backend.getOutbound();
    expect(received).toHaveLength(1);
    expect(received[0].to).toBe("user-bob");
    expect(received[0].text).toBe("echo: hi");
    expect(received[0].contextToken).toBe("ctx-out");
  });

  it("propagates AbortError when the abort signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      getUpdates({
        apiUrl: backend.baseUrl,
        token: TOKEN,
        cursor: "",
        timeoutSec: 5,
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow();
  });
});
