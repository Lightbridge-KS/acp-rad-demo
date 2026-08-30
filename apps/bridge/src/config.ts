import path from "node:path";

export type BridgeConfig = {
  port: number;
  trace: boolean;
  llmEnabled: boolean;
  activeSessionLimit: number;
  leaseTtlSeconds: number;
  leaseHeartbeatSeconds: number;
  auditRetentionSeconds: number;
  auditDir: string;
  environment: string;
  redisUrl?: string;
  redisToken?: string;
};

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function boolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`${name} must be true or false`);
}

function bridgePort(): number {
  return process.env.PORT ? integer("PORT", 8787) : integer("BRIDGE_PORT", 8787);
}

export function loadConfig(bridgeRoot: string): BridgeConfig {
  const onVercel = Boolean(process.env.VERCEL);
  const environment = process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development";
  const llmEnabled = boolean("DEMO_LLM_ENABLED", !onVercel || environment === "production");
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;

  if (onVercel && (!redisUrl || !redisToken)) throw new Error("Vercel deployments require Upstash Redis credentials");
  if (onVercel && environment === "production" && llmEnabled) {
    if (!process.env.AI_GATEWAY_API_KEY) throw new Error("Production LLM access requires AI_GATEWAY_API_KEY");
    if (process.env.RAD_MODEL_BASE_URL !== "https://ai-gateway.vercel.sh/v1") {
      throw new Error("Production LLM access requires RAD_MODEL_BASE_URL=https://ai-gateway.vercel.sh/v1");
    }
  }

  return {
    port: bridgePort(),
    trace: process.env.BRIDGE_TRACE === "1",
    llmEnabled,
    activeSessionLimit: integer("ACTIVE_SESSION_LIMIT", 10),
    leaseTtlSeconds: integer("SESSION_LEASE_TTL_SECONDS", 90),
    leaseHeartbeatSeconds: integer("SESSION_LEASE_HEARTBEAT_SECONDS", 30),
    auditRetentionSeconds: integer("AUDIT_RETENTION_SECONDS", 7 * 24 * 60 * 60),
    auditDir: path.resolve(process.env.AUDIT_DIR ?? path.join(bridgeRoot, "../../audit")),
    environment,
    ...(redisUrl ? { redisUrl } : {}),
    ...(redisToken ? { redisToken } : {}),
  };
}
