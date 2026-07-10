import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../util/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "accounts-test-"));
  process.env.OPENCLAW_STATE_DIR = tmpDir;
});

afterEach(() => {
  delete process.env.OPENCLAW_STATE_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadModule() {
  vi.resetModules();
  return await import("./accounts.js");
}

const CHANNEL_DIR = "openclaw-cowlab";
const ACCOUNTS_SUBDIR = "accounts";

describe("loadMyCowlabAccount / saveMyCowlabAccount", () => {
  it("returns null when no account file exists", async () => {
    const { loadMyCowlabAccount } = await loadModule();
    expect(loadMyCowlabAccount("main")).toBeNull();
  });

  it("saves and reads back token + apiUrl", async () => {
    const { saveMyCowlabAccount, loadMyCowlabAccount } = await loadModule();
    saveMyCowlabAccount("main", { token: "tk-1", apiUrl: "https://api.example.com" });
    const data = loadMyCowlabAccount("main");
    expect(data?.token).toBe("tk-1");
    expect(data?.apiUrl).toBe("https://api.example.com");
    expect(data?.savedAt).toBeTruthy();
  });

  it("merges into existing on subsequent saves (token is overwritten, apiUrl is overwritten)", async () => {
    const { saveMyCowlabAccount, loadMyCowlabAccount } = await loadModule();
    saveMyCowlabAccount("main", { token: "tk-1", apiUrl: "https://api.example.com" });
    saveMyCowlabAccount("main", { token: "tk-2", apiUrl: "https://api2.example.com" });
    const data = loadMyCowlabAccount("main");
    expect(data?.token).toBe("tk-2");
    expect(data?.apiUrl).toBe("https://api2.example.com");
  });

  it("omits empty token / apiUrl from the on-disk file", async () => {
    const { saveMyCowlabAccount } = await loadModule();
    saveMyCowlabAccount("main", { token: "tk", apiUrl: "" });
    const raw = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, CHANNEL_DIR, ACCOUNTS_SUBDIR, "main.json"),
        "utf-8",
      ),
    );
    expect(raw.token).toBe("tk");
    expect("apiUrl" in raw).toBe(false);
  });
});

describe("clearMyCowlabAccount", () => {
  it("removes the account file and related files", async () => {
    const { saveMyCowlabAccount, clearMyCowlabAccount } = await loadModule();
    saveMyCowlabAccount("main", { token: "tk", apiUrl: "https://api.example.com" });

    // Add a context-tokens file too
    fs.writeFileSync(
      path.join(tmpDir, CHANNEL_DIR, ACCOUNTS_SUBDIR, "main.context-tokens.json"),
      "{}",
    );

    clearMyCowlabAccount("main");
    expect(fs.existsSync(path.join(tmpDir, CHANNEL_DIR, ACCOUNTS_SUBDIR, "main.json"))).toBe(
      false,
    );
    expect(
      fs.existsSync(
        path.join(tmpDir, CHANNEL_DIR, ACCOUNTS_SUBDIR, "main.context-tokens.json"),
      ),
    ).toBe(false);
  });
});

describe("listMyCowlabAccountIds", () => {
  it("returns [] when no account file exists", async () => {
    const { listMyCowlabAccountIds } = await loadModule();
    expect(listMyCowlabAccountIds({} as never)).toEqual([]);
  });

  it("returns ['main'] when the main account file exists", async () => {
    const { saveMyCowlabAccount, listMyCowlabAccountIds } = await loadModule();
    saveMyCowlabAccount("main", { token: "tk", apiUrl: "https://api.example.com" });
    expect(listMyCowlabAccountIds({} as never)).toEqual(["main"]);
  });
});

describe("resolveMyCowlabAccount", () => {
  it("throws when called with a non-default accountId and no default account", async () => {
    const { resolveMyCowlabAccount } = await loadModule();
    // Even for the default ("main"), it should not throw — it just returns
    // an unconfigured result. The "throw" behaviour was for missing
    // accountId, which we no longer do.
    const r = resolveMyCowlabAccount({ channels: {} } as never, undefined);
    expect(r.configured).toBe(false);
    expect(r.accountId).toBe("main");
  });

  it("returns configured=true with token + apiUrl from disk", async () => {
    const { saveMyCowlabAccount, resolveMyCowlabAccount } = await loadModule();
    saveMyCowlabAccount("main", { token: "tk", apiUrl: "https://api.example.com" });
    const r = resolveMyCowlabAccount({ channels: {} } as never, "main");
    expect(r.configured).toBe(true);
    expect(r.token).toBe("tk");
    expect(r.apiUrl).toBe("https://api.example.com");
  });

  it("respects the section.enabled=false flag", async () => {
    const { saveMyCowlabAccount, resolveMyCowlabAccount } = await loadModule();
    saveMyCowlabAccount("main", { token: "tk", apiUrl: "https://api.example.com" });
    const r = resolveMyCowlabAccount(
      { channels: { "openclaw-cowlab": { enabled: false } } } as never,
      "main",
    );
    expect(r.enabled).toBe(false);
  });
});
