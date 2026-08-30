import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.ts";

afterEach(() => vi.unstubAllEnvs());

describe("Vercel startup configuration", () => {
  function productionBase(): void {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "redis-token");
    vi.stubEnv("DEMO_LLM_ENABLED", "true");
    vi.stubEnv("RAD_MODEL_BASE_URL", "https://ai-gateway.vercel.sh/v1");
    vi.stubEnv("AI_GATEWAY_API_KEY", "gateway-token");
    vi.stubEnv("PORT", "8080");
  }

  it("honors PORT and accepts the exact protected Production configuration", () => {
    productionBase();
    vi.stubEnv("BRIDGE_PORT", "not-used-on-vercel");
    expect(loadConfig("/tmp")).toMatchObject({
      port: 8080,
      llmEnabled: true,
      activeSessionLimit: 10,
      auditRetentionSeconds: 604_800,
    });
  });

  it("fails Production startup without Gateway or Redis", () => {
    productionBase();
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    expect(() => loadConfig("/tmp")).toThrow(/AI_GATEWAY_API_KEY/);
    productionBase();
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    expect(() => loadConfig("/tmp")).toThrow(/Redis credentials/);
  });
});
