import { describe, expect, test } from "bun:test";
import { clampIndex, clampScroll, layoutFor } from "../src/layout";

describe("responsive cell layout", () => {
  test("warns below 60 and keeps one pane through 119", () => {
    expect(layoutFor({ width: 59, height: 20 }).mode).toBe("warning");
    expect(layoutFor({ width: 60, height: 19 }).mode).toBe("warning");
    expect(layoutFor({ width: 79, height: 20 }).mode).toBe("one-pane");
    expect(layoutFor({ width: 119, height: 20 }).mode).toBe("one-pane");
  });
  test("allocates bounded list and non-zero detail at 120", () => {
    const result = layoutFor({ width: 120, height: 20 });
    expect(result.mode).toBe("two-pane");
    expect(result.list.width).toBeGreaterThanOrEqual(35);
    expect(result.detail?.width).toBeGreaterThan(0);
  });
  test("uses full shell at 160 and clamps scroll", () => {
    expect(layoutFor({ width: 160, height: 20 }).mode).toBe("full-shell");
    expect(clampScroll(100, 20, 10)).toBe(10);
    expect(clampIndex(-1, 4)).toBe(0);
    expect(clampIndex(9, 4)).toBe(3);
  });
});
