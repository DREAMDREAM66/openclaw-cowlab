import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendMessage, getUpdates, DEFAULT_LONG_POLL_TIMEOUT_SEC } from "./client.js";

// Pattern: mock logger + node:fetch (via vi.stubGlobal) + node:crypto
vi.mock("../util/logger.js", () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    withAccount: () => ({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      getLogFilePath: () => "/tmp/test.log",
    }),
  },
}));

const mockFetch = vi.fn();

function mockResponse(body: unknown, status = 200, ok = true): Response {
  return {
    ok,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getUpdates", () => {
  it("builds the long-poll URL with cursor + timeout, sends Bearer auth", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ messages: [], cursor: "abc" }),
    );

    const result = await getUpdates({
      apiUrl: "https://api.example.com",
      token: "test-token-123",
      cursor: "abc",
    });

    expect(result).toEqual({ messages: [], cursor: "abc" });

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://api.example.com/v1/messages/poll?timeout=${DEFAULT_LONG_POLL_TIMEOUT_SEC}&cursor=abc`,
    );
    expect(init.method).toBe("GET");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token-123");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("returns messages from the response body", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        messages: [
          { id: "m1", from: "u1", text: "hi", contextToken: "ctx-1" },
        ],
        cursor: "next",
      }),
    );

    const result = await getUpdates({
      apiUrl: "https://api.example.com",
      token: "tok",
      cursor: "",
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].text).toBe("hi");
    expect(result.cursor).toBe("next");
  });

  it("returns empty response on client-side timeout (AbortError without external abort)", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    mockFetch.mockRejectedValueOnce(abortErr);

    const result = await getUpdates({
      apiUrl: "https://api.example.com",
      token: "tok",
      cursor: "cur",
    });
    expect(result).toEqual({ messages: [], cursor: "cur" });
  });

  it("rethrows AbortError when external signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    mockFetch.mockRejectedValueOnce(abortErr);

    await expect(
      getUpdates({
        apiUrl: "https://api.example.com",
        token: "tok",
        cursor: "",
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow("aborted");
  });

  it("throws on non-2xx response", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse("server down", 503, false));

    await expect(
      getUpdates({
        apiUrl: "https://api.example.com",
        token: "tok",
        cursor: "",
      }),
    ).rejects.toThrow(/getUpdates 503/);
  });

  it("honors a custom timeoutSec", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ messages: [], cursor: "" }));

    await getUpdates({
      apiUrl: "https://api.example.com",
      token: "tok",
      cursor: "",
      timeoutSec: 5,
    });
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain("timeout=5");
  });
});

describe("sendMessage", () => {
  it("POSTs JSON body with Bearer auth, parses response", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ messageId: "msg-1" }));

    const result = await sendMessage({
      apiUrl: "https://api.example.com",
      token: "test-tok",
      to: "user-alice",
      text: "hello",
    });

    expect(result).toEqual({ messageId: "msg-1" });

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/messages");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      to: "user-alice",
      text: "hello",
    });
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-tok");
  });

  it("includes contextToken in body when provided", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ messageId: "msg-2" }));

    await sendMessage({
      apiUrl: "https://api.example.com",
      token: "tok",
      to: "u",
      text: "t",
      contextToken: "ctx-abc",
    });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      to: "u",
      text: "t",
      contextToken: "ctx-abc",
    });
  });

  it("omits contextToken from body when empty string", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ messageId: "msg-3" }));

    await sendMessage({
      apiUrl: "https://api.example.com",
      token: "tok",
      to: "u",
      text: "t",
      contextToken: "",
    });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ to: "u", text: "t" });
  });

  it("throws on non-2xx response", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse("forbidden", 403, false));

    await expect(
      sendMessage({
        apiUrl: "https://api.example.com",
        token: "tok",
        to: "u",
        text: "t",
      }),
    ).rejects.toThrow(/sendMessage 403/);
  });

  it("throws on empty response body", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(""),
    } as unknown as Response);

    await expect(
      sendMessage({
        apiUrl: "https://api.example.com",
        token: "tok",
        to: "u",
        text: "t",
      }),
    ).rejects.toThrow(/empty response body/);
  });
});
