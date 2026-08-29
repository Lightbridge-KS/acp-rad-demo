/**
 * Live smoke: headless ACP client → bridge → agent → LLM, serving the report from a
 * ReportStore built over the on-disk fixtures (same code path as the editor).
 *
 *   BRIDGE_URL=ws://localhost:8787/acp?agent=rad node scripts/smoke.ts
 *
 * Exit 0 iff: the agent advertises `_meta.rad`; prompt 1 streams PONG with `end_turn`;
 * prompt 2 makes the agent read the FINDINGS section through `fs/read_text_file`
 * (a `read` tool call) and answer with the first organ label.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { RadError, createReportStore, markdownToDelta, sliceLines } from "acp-rad";

const url = process.env.BRIDGE_URL ?? "ws://localhost:8787/acp?agent=rad";
const ACCESSION = "ACC0000001";
const here = path.dirname(fileURLToPath(import.meta.url));
const FX = path.resolve(here, "../../editor/fixtures");
const read = (rel: string) => readFileSync(path.join(FX, rel), "utf8");
const collection = (dir: string) =>
  Object.fromEntries(
    readdirSync(path.join(FX, dir))
      .filter((f) => f.endsWith(".md"))
      .map((f) => [f.replace(/\.md$/, ""), read(`${dir}/${f}`)]),
  );

const store = createReportStore({
  accession: ACCESSION,
  getOps: () => markdownToDelta(read("ct-brain-er-stroke/report.md")),
  meta: JSON.parse(read("ct-brain-er-stroke/meta.json")) as Record<string, unknown>,
  templates: collection("templates"),
  snippets: collection("snippets"),
});

const counts = { fsRead: 0, readToolCalls: 0 };
let text = "";
const say = (s: string) => process.stderr.write(`${s}\n`);

const stream = createWebSocketStream(url);
const conn = acp
  .client({ name: "acp-rad-smoke" })
  .onNotification(acp.methods.client.session.update, (ctx) => {
    const u = ctx.params.update;
    if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") {
      text += u.content.text;
      process.stdout.write(u.content.text);
    } else if (u.sessionUpdate === "tool_call") {
      if (u.kind === "read") counts.readToolCalls += 1;
      say(`[tool_call] ${u.kind} ${u.title}`);
    } else if (u.sessionUpdate !== "tool_call_update") {
      say(`[update] ${u.sessionUpdate}`);
    }
  })
  .onRequest(acp.methods.client.fs.readTextFile, (ctx) => {
    counts.fsRead += 1;
    say(`[fs/read_text_file] ${ctx.params.path}`);
    try {
      return { content: sliceLines(store.read(ctx.params.path), ctx.params.line, ctx.params.limit) };
    } catch (err) {
      if (err instanceof RadError) throw new acp.RequestError(err.code, err.message);
      throw err;
    }
  })
  .onRequest(acp.methods.client.fs.writeTextFile, (ctx) => {
    try {
      store.write(ctx.params.path, ctx.params.content);
    } catch (err) {
      if (err instanceof RadError) throw new acp.RequestError(err.code, err.message);
      throw err;
    }
    return {};
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
  say(`[init] agent=${init.agentInfo?.name ?? "?"} _meta=${JSON.stringify(init._meta)}`);
  const radCaps = (init._meta as Record<string, unknown> | undefined)?.rad;

  const manifest = store.manifest();
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
        manifest,
      },
    },
  });
  say(`[session] ${session.sessionId} manifest=${manifest.length} files`);

  // Prompt 1 — transport sanity.
  const r1 = await conn.agent.request(acp.methods.agent.session.prompt, {
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "Reply with exactly the word PONG and nothing else." }],
  });
  process.stdout.write("\n");
  const pong = /PONG/i.test(text) && r1.stopReason === "end_turn";
  say(`[prompt 1] stopReason=${r1.stopReason} pong=${pong}`);

  // Prompt 2 — the report is served by the client.
  text = "";
  const r2 = await conn.agent.request(acp.methods.agent.session.prompt, {
    sessionId: session.sessionId,
    prompt: [
      {
        type: "text",
        text:
          `Use your read_file tool to read /worklist/${ACCESSION}/sections/findings.md (do not answer ` +
          "from memory). Then reply with only the organ label of its first finding line " +
          "(the bold text before the colon), nothing else.",
      },
    ],
  });
  process.stdout.write("\n");
  say(`[prompt 2] stopReason=${r2.stopReason}`);

  const checks = {
    radCapsAdvertised: radCaps !== undefined,
    pong,
    fsReadServed: counts.fsRead >= 1,
    readToolCall: counts.readToolCalls >= 1,
    organLabel: /cerebral parenchyma/i.test(text),
    endTurn: r2.stopReason === "end_turn",
  };
  say(`[checks] ${JSON.stringify(checks)}`);
  const ok = Object.values(checks).every(Boolean);
  say(ok ? "SMOKE OK" : "SMOKE FAILED");
  conn.close();
  process.exit(ok ? 0 : 1);
} catch (err) {
  say(`SMOKE ERROR: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  conn.close();
  process.exit(2);
}
