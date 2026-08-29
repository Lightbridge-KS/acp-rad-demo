/**
 * Bridge: WebSocket ⇄ stdio launcher for ACP agents.
 *
 * One WebSocket connection = one agent subprocess. The bridge does not parse
 * ACP; it only re-frames: agent stdout NDJSON lines → one WS frame per line,
 * WS frames → one NDJSON line each on agent stdin. The editor in the browser
 * is the ACP Client; the agent is the ACP Agent; this is a pipe.
 *
 *   GET /acp?agent=<id>   id ∈ agents.json (default "rad")
 *   GET /health           → 200 "ok"
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

type AgentSpec = { cmd: string; args: string[]; env?: Record<string, string> };

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgeRoot = path.resolve(here, "..");
const agents: Record<string, AgentSpec> = JSON.parse(
  readFileSync(path.join(bridgeRoot, "agents.json"), "utf8"),
);
const PORT = Number(process.env.BRIDGE_PORT ?? 8787);

const log = (msg: string): void => {
  process.stderr.write(`[bridge ${new Date().toISOString()}] ${msg}\n`);
};

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server, path: "/acp" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const id = url.searchParams.get("agent") ?? "rad";
  const spec = agents[id];
  if (!spec) {
    log(`rejecting unknown agent "${id}"`);
    ws.close(4004, `unknown agent: ${id}`);
    return;
  }

  const child = spawn(spec.cmd, spec.args, {
    cwd: bridgeRoot,
    env: { ...process.env, ...spec.env },
    stdio: ["pipe", "pipe", "inherit"], // agent stderr → bridge stderr (logs)
  });
  log(`[${id}] spawned pid=${child.pid}: ${spec.cmd} ${spec.args.join(" ")}`);

  // agent → browser: NDJSON lines → one frame per line
  let pending = "";
  child.stdout.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    let nl: number;
    while ((nl = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      if (line && ws.readyState === WebSocket.OPEN) ws.send(line);
    }
  });

  // browser → agent: one frame → one line
  ws.on("message", (data) => {
    child.stdin.write(`${data.toString()}\n`);
  });

  ws.on("close", (code, reason) => {
    log(`[${id}] socket closed (${code} ${reason.toString()}), killing pid=${child.pid}`);
    child.kill();
  });

  child.on("exit", (code, signal) => {
    log(`[${id}] agent exited code=${code} signal=${signal}`);
    if (ws.readyState === WebSocket.OPEN) ws.close(1011, `agent exited (${code ?? signal})`);
  });

  child.on("error", (err) => {
    log(`[${id}] spawn error: ${err.message}`);
    if (ws.readyState === WebSocket.OPEN) ws.close(1011, `agent failed to start`);
  });
});

server.listen(PORT, () => {
  log(`listening on ws://localhost:${PORT}/acp (agents: ${Object.keys(agents).join(", ")})`);
});
