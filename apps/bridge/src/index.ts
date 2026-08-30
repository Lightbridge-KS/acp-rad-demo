/** Vercel/local entrypoint for the anonymous, capacity-limited WebSocket to stdio bridge. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAuditWriter } from "./audit.ts";
import { loadConfig } from "./config.ts";
import { createBridgeServer, type AgentSpec } from "./server.ts";
import { MemoryState, UpstashState } from "./state.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgeRoot = path.resolve(here, "..");
const config = loadConfig(bridgeRoot);
const agents = JSON.parse(readFileSync(path.join(bridgeRoot, "agents.json"), "utf8")) as Record<string, AgentSpec>;
const log = (message: string): void => {
  process.stderr.write(`[bridge ${new Date().toISOString()}] ${message}\n`);
};
const state = config.redisUrl && config.redisToken
  ? new UpstashState(config.redisUrl, config.redisToken, config.environment)
  : new MemoryState();
const audit = createAuditWriter(config.redisUrl ? state : null, config.auditDir, config.auditRetentionSeconds, log);
const bridge = createBridgeServer({ config, state, audit, agents, bridgeRoot, log });

bridge.server.listen(config.port, () => {
  log(`listening on port ${config.port} at /acp (agents: ${Object.keys(agents).join(", ")})`);
});

let stopping = false;
const stop = (signal: string): void => {
  if (stopping) return;
  stopping = true;
  log(`${signal} received; draining connections`);
  void bridge.shutdown().finally(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
