/**
 * Live smoke for the tracer bullet: headless ACP client → bridge → agent → LLM.
 *
 *   BRIDGE_URL=ws://localhost:8787/acp?agent=rad node scripts/smoke.ts
 *
 * Exit 0 iff the agent advertises `_meta.rad`, streams a message chunk
 * containing PONG, and ends the turn with `end_turn`.
 */
import * as acp from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";

const url = process.env.BRIDGE_URL ?? "ws://localhost:8787/acp?agent=rad";
const ACCESSION = "ACC0000001";

let text = "";
const stream = createWebSocketStream(url);
const conn = acp
  .client({ name: "acp-rad-smoke" })
  .onNotification(acp.methods.client.session.update, (ctx) => {
    const u = ctx.params.update;
    if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") {
      text += u.content.text;
      process.stdout.write(u.content.text);
    } else {
      process.stderr.write(`[update] ${u.sessionUpdate}\n`);
    }
  })
  .onRequest(acp.methods.client.session.requestPermission, () => ({
    outcome: { outcome: "cancelled" as const },
  }))
  .connect(stream);

try {
  const init = await conn.agent.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    clientInfo: { name: "acp-rad-smoke", version: "0.0.0" },
    _meta: {
      rad: { profileVersion: "0.1", focusState: true, criticalFindings: true, clinicalPermissionVerbs: true },
    },
  });
  process.stderr.write(`[init] agent=${init.agentInfo?.name ?? "?"} _meta=${JSON.stringify(init._meta)}\n`);
  const radCaps = (init._meta as Record<string, unknown> | undefined)?.rad;

  const session = await conn.agent.request(acp.methods.agent.session.new, {
    cwd: `/worklist/${ACCESSION}`,
    mcpServers: [],
    _meta: {
      rad: {
        accession: ACCESSION,
        modality: "CT",
        region: "brain",
        protocol: "noncontrast",
        setting: "ER",
        reportStatus: "preliminary",
        phiBoundary: "research_synthetic",
      },
    },
  });
  process.stderr.write(`[session] ${session.sessionId}\n`);

  const result = await conn.agent.request(acp.methods.agent.session.prompt, {
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "Reply with exactly the word PONG and nothing else." }],
  });
  process.stdout.write("\n");
  process.stderr.write(`[prompt] stopReason=${result.stopReason}\n`);

  const checks = {
    radCapsAdvertised: radCaps !== undefined,
    pong: /PONG/i.test(text),
    endTurn: result.stopReason === "end_turn",
  };
  process.stderr.write(`[checks] ${JSON.stringify(checks)}\n`);
  const ok = Object.values(checks).every(Boolean);
  process.stderr.write(ok ? "SMOKE OK\n" : "SMOKE FAILED\n");
  conn.close();
  process.exit(ok ? 0 : 1);
} catch (err) {
  process.stderr.write(`SMOKE ERROR: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  conn.close();
  process.exit(2);
}
