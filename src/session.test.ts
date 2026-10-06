import { describe, expect, it } from "vitest";
import { newSessionToken } from "./session.js";

describe("session token generation", () => {
 it("returns unique high-entropy base64url tokens", () => {
 const first = newSessionToken();
 const second = newSessionToken();
 expect(first).not.toBe(second);
 expect(first.length).toBeGreaterThanOrEqual(64);
 expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
 });
});
