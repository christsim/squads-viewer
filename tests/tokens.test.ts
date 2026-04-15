import { describe, it, expect } from "vitest";
import { formatUsd, formatBalance } from "../src/tokens";

describe("formatUsd", () => {
  it("returns '--' for null", () => {
    expect(formatUsd(null)).toBe("--");
  });

  it("formats zero correctly", () => {
    expect(formatUsd(0)).toBe("$0.00");
  });

  it("formats large values with commas", () => {
    expect(formatUsd(1234567.89)).toBe("$1,234,567.89");
  });

  it("formats small values", () => {
    expect(formatUsd(0.5)).toBe("$0.50");
  });

  it("returns '<$0.01' for very small positive values", () => {
    expect(formatUsd(0.001)).toBe("<$0.01");
    expect(formatUsd(0.009)).toBe("<$0.01");
  });

  it("formats exact cents", () => {
    expect(formatUsd(0.01)).toBe("$0.01");
  });
});

describe("formatBalance", () => {
  it("returns '0' for zero", () => {
    expect(formatBalance(0)).toBe("0");
  });

  it("formats with default 4 decimal places", () => {
    const result = formatBalance(1.23456789);
    expect(result).toContain("1.234");
  });

  it("formats with custom decimal places", () => {
    const result = formatBalance(1.123456789, 6);
    expect(result).toContain("1.12345");
  });

  it("handles large numbers", () => {
    const result = formatBalance(1000000);
    expect(result).toContain("1,000,000");
  });
});
