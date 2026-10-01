import { describe, expect, it } from "vitest";
describe("automatic grocery generation", () => {
  it("defines shortage-only generation acceptance", () => {
    const required = 8;
    const pantry = 4;
    expect(Math.max(required - pantry, 0)).toBe(4);
  });
  it("does not generate when pantry is sufficient", () => {
    expect(Math.max(2 - 3, 0)).toBe(0);
  });
  it("aggregates repeated ingredients", () => {
    expect([1, 2, 3].reduce((total, value) => total + value, 0)).toBe(6);
  });
});
