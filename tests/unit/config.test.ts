import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config.js";

const base = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://x",
  COOKIE_SECRET: "12345678901234567890123456789012",
  SESSION_PEPPER: "22345678901234567890123456789012",
  CORS_ORIGIN: "http://localhost:3000",
  ENTRA_TENANT_ID: "t",
  ENTRA_API_CLIENT_ID: "c",
  ENTRA_ISSUER: "https://example.com/v2.0",

  OPENAI_API_KEY: "test-openai-key",
  OPENAI_VISION_MODEL: "gpt-4.1-mini"
};

describe("config", () => {
  it("validates environment", () => {
    expect(loadConfig(base as any).PORT).toBe(3001);
  });

  it("rejects short secrets", () => {
    expect(() =>
      loadConfig({
        ...base,
        COOKIE_SECRET: "short"
      } as any)
    ).toThrow();
  });
});
