import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createAuditWriter } from "./audit.ts";
import type { BridgeConfig } from "./config.ts";
import { createBridgeServer } from "./server.ts";
import { MemoryState } from "./state.ts";

const openServers: Array<ReturnType<typeof createBridgeServer>> = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((bridge) => bridge.shutdown()));
});

function config(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    port: 0,
    trace: false,
    llmEnabled: true,
    activeSessionLimit: 10,
    leaseTtlSeconds: 90,
    leaseHeartbeatSeconds: 30,
    auditRetentionSeconds: 604_800,
    auditDir: "/tmp/acp-rad-test-audit",
    environment: "test",
    ...overrides,
  };
}

async function start(bridgeConfig: BridgeConfig, state = new MemoryState()) {
  let spawns = 0;
  const bridge = createBridgeServer({
    config: bridgeConfig,
    state,
    audit: createAuditWriter(state, bridgeConfig.auditDir, bridgeConfig.auditRetentionSeconds, () => undefined),
    agents: { rad: { cmd: "unused", args: [] } },
    bridgeRoot: "/tmp",
    log: () => undefined,
    spawnAgent: () => {
      spawns += 1;
      throw new Error("test agent must not spawn");
    },
  });
  await new Promise<void>((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
  openServers.push(bridge);
  const port = (bridge.server.address() as AddressInfo).port;
  return { bridge, state, port, spawns: () => spawns };
}

function closeCode(url: string, origin: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin });
    ws.once("close", (code) => resolve(code));
    ws.once("error", reject);
  });
}

describe("HTTP surface", () => {
  it("exposes only health outside the WebSocket route", async () => {
    const { port } = await start(config());
    expect(await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json())).toEqual({ status: "ok" });
    expect(await fetch(`http://127.0.0.1:${port}/api/auth/session`).then((response) => response.status)).toBe(404);
  });
});

describe("WebSocket admission", () => {
  it("rejects Preview-disabled sessions without spawning", async () => {
    const preview = await start(config({ llmEnabled: false }));
    await expect(closeCode(`ws://127.0.0.1:${preview.port}/acp`, `http://127.0.0.1:${preview.port}`)).resolves.toBe(4403);
    expect(preview.spawns()).toBe(0);
  });

  it("rejects capacity before spawning", async () => {
    const state = new MemoryState();
    await state.acquireLease("occupied", Date.now(), 90_000, 1);
    const busy = await start(config({ activeSessionLimit: 1 }), state);
    await expect(closeCode(`ws://127.0.0.1:${busy.port}/acp`, `http://127.0.0.1:${busy.port}`)).resolves.toBe(4429);
    expect(busy.spawns()).toBe(0);
  });

  it("fails closed when the admission store is unavailable", async () => {
    class FailingState extends MemoryState {
      override async acquireLease(): Promise<boolean> {
        throw new Error("redis unavailable");
      }
    }
    const target = await start(config(), new FailingState());
    await expect(closeCode(`ws://127.0.0.1:${target.port}/acp`, `http://127.0.0.1:${target.port}`)).resolves.toBe(1013);
    expect(target.spawns()).toBe(0);
  });

  it("admits an anonymous same-origin socket before spawning", async () => {
    const bridgeConfig = config();
    const state = new MemoryState();
    let spawns = 0;
    const bridge = createBridgeServer({
      config: bridgeConfig,
      state,
      audit: createAuditWriter(state, bridgeConfig.auditDir, bridgeConfig.auditRetentionSeconds, () => undefined),
      agents: { rad: { cmd: "unused", args: [] } },
      bridgeRoot: "/tmp",
      log: () => undefined,
      spawnAgent: () => {
        spawns += 1;
        return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["pipe", "pipe", "inherit"] });
      },
    });
    await new Promise<void>((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
    openServers.push(bridge);
    const port = (bridge.server.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/acp`, {
        origin: `http://127.0.0.1:${port}`,
      });
      ws.once("open", () => {
        expect(spawns).toBe(1);
        ws.close();
      });
      ws.once("close", () => resolve());
      ws.once("error", reject);
    });
  });

  it("rejects a cross-origin upgrade before spawning", async () => {
    const target = await start(config());
    await expect(closeCode(`ws://127.0.0.1:${target.port}/acp`, "https://evil.example")).rejects.toThrow(/403/);
    expect(target.spawns()).toBe(0);
  });
});
