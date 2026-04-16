import { describe, it, expect } from "vitest";
import {
  DEFAULT_SETTINGS,
  SQUADS_V4_PROGRAM_ID,
  THEME_LABELS,
  RPC_PRESETS,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "../src/types";

describe("DEFAULT_SETTINGS", () => {
  it("has a valid default RPC URL", () => {
    expect(DEFAULT_SETTINGS.rpcUrl).toMatch(/^https:\/\//);
  });

  it("defaults to swiss-vault theme", () => {
    expect(DEFAULT_SETTINGS.theme).toBe("swiss-vault");
  });

  it("defaults to squads-api resolution", () => {
    expect(DEFAULT_SETTINGS.resolutionMethod).toBe("squads-api");
  });

  it("defaults vault scan max to 3", () => {
    expect(DEFAULT_SETTINGS.vaultScanMax).toBe(3);
  });

  it("defaults helius API key to empty string", () => {
    expect(DEFAULT_SETTINGS.heliusApiKey).toBe("");
  });

  it("defaults SNS resolution to false", () => {
    expect(DEFAULT_SETTINGS.resolveSns).toBe(false);
  });
});

describe("constants", () => {
  it("SQUADS_V4_PROGRAM_ID is correct", () => {
    expect(SQUADS_V4_PROGRAM_ID).toBe("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");
  });

  it("TOKEN_PROGRAM_ID is correct", () => {
    expect(TOKEN_PROGRAM_ID).toBe("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  });

  it("TOKEN_2022_PROGRAM_ID is correct", () => {
    expect(TOKEN_2022_PROGRAM_ID).toBe("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
  });
});

describe("THEME_LABELS", () => {
  it("has all 4 themes", () => {
    expect(Object.keys(THEME_LABELS)).toHaveLength(4);
    expect(THEME_LABELS["swiss-vault"]).toBe("Swiss Vault");
    expect(THEME_LABELS["mission-control"]).toBe("Mission Control");
    expect(THEME_LABELS["raw-protocol"]).toBe("Raw Protocol");
    expect(THEME_LABELS["dark-terminal"]).toBe("Dark Terminal");
  });
});

describe("RPC_PRESETS", () => {
  it("has at least 2 presets", () => {
    expect(RPC_PRESETS.length).toBeGreaterThanOrEqual(2);
  });

  it("all presets have label and url", () => {
    for (const preset of RPC_PRESETS) {
      expect(preset.label).toBeTruthy();
      expect(preset.url).toMatch(/^https:\/\//);
    }
  });

  it("first preset is the default (PublicNode)", () => {
    expect(RPC_PRESETS[0].url).toBe(DEFAULT_SETTINGS.rpcUrl);
  });
});
