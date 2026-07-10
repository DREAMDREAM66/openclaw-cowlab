import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadStaticTokenConfig, getMyCowlabSection } from "./login.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

vi.mock("../util/logger.js", () => ({
  logger: {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
  },
}));

const savedEnv: { url?: string; token?: string } = {};

beforeEach(() => {
  savedEnv.url = process.env.OPENCLAW_COWLAB_API_URL;
  savedEnv.token = process.env.OPENCLAW_COWLAB_API_TOKEN;
  delete process.env.OPENCLAW_COWLAB_API_URL;
  delete process.env.OPENCLAW_COWLAB_API_TOKEN;
});

afterEach(() => {
  if (savedEnv.url !== undefined) process.env.OPENCLAW_COWLAB_API_URL = savedEnv.url;
  if (savedEnv.token !== undefined) process.env.OPENCLAW_COWLAB_API_TOKEN = savedEnv.token;
});

function cfgWith(section: Record<string, unknown> | undefined): OpenClawConfig {
  return {
    channels: section ? { "openclaw-cowlab": section } : {},
  } as unknown as OpenClawConfig;
}

describe("getMyCowlabSection", () => {
  it("returns the section when present", () => {
    const section = { apiUrl: "x", apiToken: "y" };
    expect(getMyCowlabSection(cfgWith(section))).toEqual(section);
  });

  it("throws when the section is missing", () => {
    expect(() => getMyCowlabSection(cfgWith(undefined))).toThrow(/missing config section/);
  });
});

describe("loadStaticTokenConfig", () => {
  it("returns apiUrl + token from the config", () => {
    const cfg = cfgWith({ apiUrl: "https://api.example.com", apiToken: "secret" });
    expect(loadStaticTokenConfig(cfg)).toEqual({
      apiUrl: "https://api.example.com",
      token: "secret",
    });
  });

  it("prefers env-var overrides over config", () => {
    process.env.OPENCLAW_COWLAB_API_URL = "https://env.example.com";
    process.env.OPENCLAW_COWLAB_API_TOKEN = "env-token";
    const cfg = cfgWith({ apiUrl: "https://cfg.example.com", apiToken: "cfg-token" });
    expect(loadStaticTokenConfig(cfg)).toEqual({
      apiUrl: "https://env.example.com",
      token: "env-token",
    });
  });

  it("throws when apiUrl is missing", () => {
    const cfg = cfgWith({ apiToken: "t" });
    expect(() => loadStaticTokenConfig(cfg)).toThrow(/apiUrl is required/);
  });

  it("throws when apiToken is missing", () => {
    const cfg = cfgWith({ apiUrl: "https://api.example.com" });
    expect(() => loadStaticTokenConfig(cfg)).toThrow(/apiToken is required/);
  });

  it("throws when both are missing (empty section)", () => {
    const cfg = cfgWith({});
    expect(() => loadStaticTokenConfig(cfg)).toThrow(/apiUrl is required/);
  });

  it("trims whitespace from values", () => {
    const cfg = cfgWith({ apiUrl: "  https://api.example.com  ", apiToken: "  tok  " });
    expect(loadStaticTokenConfig(cfg)).toEqual({
      apiUrl: "https://api.example.com",
      token: "tok",
    });
  });
});
