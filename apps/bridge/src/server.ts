import { randomUUID } from "node:crypto";
import type { ChildProcessByStdio } from "node:child_process";
import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { Duplex, Readable, Writable } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { AuditWriter } from "./audit.ts";
import type { BridgeConfig } from "./config.ts";
import type { SharedState } from "./state.ts";

export type AgentSpec = { cmd: string; args: string[]; env?: Record<string, string> };
type AgentProcess = ChildProcessByStdio<Writable, Readable, null>;
type ActiveConnection = {
  ws: WebSocket;
  child: AgentProcess;
  member: string;
  release: () => Promise<void>;
};

export type BridgeDependencies = {
  config: BridgeConfig;
  state: SharedState;
  audit: AuditWriter;
  agents: Record<string, AgentSpec>;
  bridgeRoot: string;
  log: (message: string) => void;
  spawnAgent?: (spec: AgentSpec, bridgeRoot: string) => AgentProcess;
};

function json(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function requestHost(req: IncomingMessage): string | undefined {
  const forwarded = req.headers["x-forwarded-host"];
  return (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0])?.trim() || req.headers.host;
}

export function hasValidOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  const host = requestHost(req);
  if (!origin || !host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function defaultSpawn(spec: AgentSpec, bridgeRoot: string): AgentProcess {
  return spawn(spec.cmd, spec.args, {
    cwd: bridgeRoot,
    env: { ...process.env, ...spec.env },
    stdio: ["pipe", "pipe", "inherit"],
  });
}

export function createBridgeServer(deps: BridgeDependencies) {
  const { config, state, audit, agents, bridgeRoot, log } = deps;
  const spawnAgent = deps.spawnAgent ?? defaultSpawn;
  const active = new Set<ActiveConnection>();
  const wss = new WebSocketServer({ noServer: true });

  const handleHttp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://bridge.local");
    if (req.method === "GET" && url.pathname === "/health") {
      try {
        await state.ping();
        json(res, 200, { status: "ok" });
      } catch {
        json(res, 503, { status: "unavailable" });
      }
      return;
    }

    res.writeHead(404, { "cache-control": "no-store" });
    res.end();
  };

  const server = createServer((req, res) => {
    void handleHttp(req, res).catch((error: unknown) => {
      log(`request failed: ${(error as Error).message}`);
      if (!res.headersSent) json(res, 500, { error: "internal server error" });
      else res.end();
    });
  });

  const closeWithoutAgent = (req: IncomingMessage, socket: Duplex, head: Buffer, code: number, reason: string): void => {
    wss.handleUpgrade(req, socket, head, (ws) => ws.close(code, reason));
  };

  server.on("upgrade", (req, socket, head) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://bridge.local");
      if (url.pathname !== "/acp") {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      if (!hasValidOrigin(req)) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }

      if (!config.llmEnabled) {
        closeWithoutAgent(req, socket, head, 4403, "live LLM is disabled in this environment");
        return;
      }

      const member = randomUUID();
      try {
        const admitted = await state.acquireLease(member, Date.now(), config.leaseTtlSeconds * 1000, config.activeSessionLimit);
        if (!admitted) {
          closeWithoutAgent(req, socket, head, 4429, "agent capacity reached");
          return;
        }
      } catch {
        closeWithoutAgent(req, socket, head, 1013, "admission store unavailable");
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        const id = url.searchParams.get("agent") ?? "rad";
        const spec = agents[id];
        if (!spec) {
          void state.releaseLease(member).catch(() => undefined);
          ws.close(4004, `unknown agent: ${id}`);
          return;
        }

        let child: AgentProcess;
        try {
          child = spawnAgent(spec, bridgeRoot);
        } catch (error) {
          void state.releaseLease(member).catch(() => undefined);
          log(`[${id}] spawn error: ${(error as Error).message}`);
          ws.close(1011, "agent failed to start");
          return;
        }
        let released = false;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        const connection: ActiveConnection = {
          ws,
          child,
          member,
          release: async () => {
            if (released) return;
            released = true;
            if (heartbeat) clearInterval(heartbeat);
            active.delete(connection);
            await state.releaseLease(member).catch((error: unknown) => log(`lease release failed: ${(error as Error).message}`));
          },
        };
        active.add(connection);
        log(`[${id}] spawned pid=${child.pid}: ${spec.cmd} ${spec.args.join(" ")}`);

        heartbeat = setInterval(() => {
          void state.renewLease(member, Date.now(), config.leaseTtlSeconds * 1000).then((result) => {
            if (result !== "renewed" && ws.readyState === WebSocket.OPEN) {
              ws.close(1013, "admission lease lost");
            }
          }).catch(() => {
            if (ws.readyState === WebSocket.OPEN) ws.close(1013, "admission store unavailable");
          });
        }, config.leaseHeartbeatSeconds * 1000);
        heartbeat.unref();

        let pending = "";
        child.stdout.on("data", (chunk: Buffer) => {
          pending += chunk.toString("utf8");
          let newline: number;
          while ((newline = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, newline).trim();
            pending = pending.slice(newline + 1);
            if (!line) continue;
            traceFrame(config.trace, log, "←agent", line);
            if (ws.readyState === WebSocket.OPEN) ws.send(line);
          }
        });

        ws.on("message", (data) => {
          const text = data.toString();
          void audit.persist(text).then((handled) => {
            if (handled || child.stdin.destroyed) return;
            traceFrame(config.trace, log, "→agent", text);
            child.stdin.write(`${text}\n`);
          });
        });
        ws.on("close", (code, reason) => {
          log(`[${id}] socket closed (${code} ${reason.toString()}), killing pid=${child.pid}`);
          child.kill();
          void connection.release();
        });
        child.on("exit", (code, signal) => {
          log(`[${id}] agent exited code=${code} signal=${signal}`);
          void connection.release();
          if (ws.readyState === WebSocket.OPEN) ws.close(1011, `agent exited (${code ?? signal})`);
        });
        child.on("error", (error) => {
          log(`[${id}] spawn error: ${error.message}`);
          void connection.release();
          if (ws.readyState === WebSocket.OPEN) ws.close(1011, "agent failed to start");
        });
      });
    })().catch((error: unknown) => {
      log(`upgrade failed: ${(error as Error).message}`);
      socket.destroy();
    });
  });

  const shutdown = async (): Promise<void> => {
    for (const connection of active) {
      connection.ws.close(1012, "bridge restarting");
      connection.child.kill();
    }
    await Promise.allSettled([...active].map((connection) => connection.release()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { server, wss, shutdown, activeCount: () => active.size };
}

function traceFrame(enabled: boolean, log: (message: string) => void, direction: "→agent" | "←agent", line: string): void {
  if (!enabled) return;
  try {
    const message = JSON.parse(line) as { method?: string; id?: unknown; error?: unknown };
    const kind = message.method
      ? `${message.method}${message.id !== undefined ? ` #${String(message.id)}` : ""}`
      : message.error
        ? `error #${String(message.id)}`
        : `result #${String(message.id)}`;
    log(`${direction} ${kind}`);
  } catch {
    log(`${direction} (unparsable ${line.length} bytes)`);
  }
}
