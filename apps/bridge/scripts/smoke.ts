/**
 * Live smoke: headless ACP client → bridge → agent → LLM, serving the report from a
 * ReportStore built over the on-disk fixtures (same code path as the editor) and
 * accepting proposals the way the editor's sign-off does.
 *
 *   BRIDGE_URL=ws://localhost:8787/acp?agent=rad node scripts/smoke.ts
 *
 * Exit 0 iff: the agent advertises `_meta.rad`; prompt 1 streams PONG with `end_turn`;
 * prompt 2 reads FINDINGS through `fs/read_text_file`; prompt 3 proposes an impression edit
 * (`tool_call` with a diff → `session/request_permission` offering `accept_edit` → the
 * smoke accepts → `fs/write_text_file` lands the bullet), and every turn ends with `end_turn`.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { RadError, canonicalize, createReportStore, markdownToDelta, sliceLines, type Op } from "acp-rad";

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

// Start state like the editor's demo: impression blanked so there is something to draft.
const startMd = read("ct-brain-er-stroke/report.md").replace(/(\*\*IMPRESSION:\*\*\n)[\s\S]*$/, "$1- ...\n");
let ops: Op[] = markdownToDelta(startMd);

const store = createReportStore({
  accession: ACCESSION,
  getOps: () => ops,
  meta: JSON.parse(read("ct-brain-er-stroke/meta.json")) as Record<string, unknown>,
  templates: collection("templates"),
  snippets: collection("snippets"),
});

const counts = { fsRead: 0, fsWrite: 0, readToolCalls: 0, editToolCalls: 0, diffs: 0, permissions: 0 };
const offered: string[][] = [];
let text = "";
const say = (s: string) => process.stderr.write(`${s}\n`);
const rethrow = (err: unknown): never => {
  if (err instanceof RadError) throw new acp.RequestError(err.code, err.message);
  throw err;
};

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
      if (u.kind === "edit") counts.editToolCalls += 1;
      if (Array.isArray(u.content) && u.content.some((c) => (c as { type?: string }).type === "diff")) counts.diffs += 1;
      say(`[tool_call] ${u.kind} ${u.title}`);
    } else if (u.sessionUpdate === "tool_call_update") {
      if (Array.isArray(u.content) && u.content.some((c) => (c as { type?: string }).type === "diff")) counts.diffs += 1;
    } else {
      say(`[update] ${u.sessionUpdate}`);
    }
  })
  .onRequest(acp.methods.client.fs.readTextFile, (ctx) => {
    counts.fsRead += 1;
    say(`[fs/read_text_file] ${ctx.params.path}`);
    try {
      return { content: sliceLines(store.read(ctx.params.path), ctx.params.line, ctx.params.limit) };
    } catch (err) {
      return rethrow(err);
    }
  })
  .onRequest(acp.methods.client.fs.writeTextFile, (ctx) => {
    counts.fsWrite += 1;
    say(`[fs/write_text_file] ${ctx.params.path} (${ctx.params.content.length} chars)`);
    try {
      store.assertWritable(ctx.params.path);
    } catch (err) {
      return rethrow(err);
    }
    // The editor would apply the accepted hunks; the smoke accepts everything, so the write IS the new section.
    const current = store.read(ctx.params.path);
    if (ctx.params.path.endsWith("/report.md")) {
      ops = markdownToDelta(ctx.params.content);
    } else {
      ops = markdownToDelta(store.reportMarkdown().replace(current, canonicalize(ctx.params.content)));
    }
    return { _meta: { rad: { outcome: "applied" } } };
  })
  .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
    counts.permissions += 1;
    const ids = ctx.params.options.map((o) => o.optionId);
    offered.push(ids);
    say(`[request_permission] ${ctx.params.toolCall.toolCallId} options=${JSON.stringify(ids)}`);
    const pick =
      ctx.params.options.find((o) => o.optionId === "accept_edit") ??
      ctx.params.options.find((o) => o.kind === "allow_once");
    if (!pick) return { outcome: { outcome: "cancelled" as const } };
    return { outcome: { outcome: "selected" as const, optionId: pick.optionId } };
  })
  .connect(stream);

try {
  const init = await conn.agent.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    clientInfo: { name: "acp-rad-smoke", version: "0.0.0" },
    _meta: {
      rad: { profileVersion: "0.1", focusState: true, flags: true, clinicalPermissionVerbs: true },
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
        reportStatus: "draft",
        shortPrelim: false,
        phiBoundary: "research_synthetic",
        manifest,
      },
    },
  });
  say(`[session] ${session.sessionId} manifest=${manifest.length} files`);

  const prompt = async (label: string, t: string) => {
    text = "";
    const r = await conn.agent.request(acp.methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: t }],
    });
    process.stdout.write("\n");
    say(`[${label}] stopReason=${r.stopReason}`);
    return r;
  };

  const r1 = await prompt("prompt 1", "Reply with exactly the word PONG and nothing else.");
  const pong = /PONG/i.test(text) && r1.stopReason === "end_turn";

  const r2 = await prompt(
    "prompt 2",
    `Use your read_file tool to read /worklist/${ACCESSION}/sections/findings.md (do not answer from memory). ` +
      "Then reply with only the organ label of its first finding line (the bold text before the colon), nothing else.",
  );
  const organLabel = /cerebral parenchyma/i.test(text) && r2.stopReason === "end_turn";

  const BULLET = "- Acute infarction of the left MCA territory.";
  const r3 = await prompt(
    "prompt 3",
    `Use your edit_file tool on /worklist/${ACCESSION}/sections/impression.md: replace the placeholder line ` +
      "`- ...` with exactly this line: `" + BULLET + "`. Do not change anything else. Then reply with one word: DONE.",
  );
  const impression = store.read(`/worklist/${ACCESSION}/sections/impression.md`);
  say(`[impression after] ${JSON.stringify(impression)}`);

  const checks = {
    radCapsAdvertised: radCaps !== undefined,
    pong,
    fsReadServed: counts.fsRead >= 1,
    readToolCall: counts.readToolCalls >= 1,
    organLabel,
    editToolCall: counts.editToolCalls >= 1,
    diffBeforePermission: counts.diffs >= 1,
    permissionOfferedClinicalVerbs: offered.some((ids) => ids.includes("accept_edit") && !ids.includes("approve_always")),
    fsWriteServed: counts.fsWrite >= 1,
    impressionLanded: impression.includes(BULLET) && !impression.includes("- ..."),
    endTurn: r3.stopReason === "end_turn",
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
