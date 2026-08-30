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
 * Stage 2 (slice 4): a second session on the CT chest case with priors — the agent advertises
 * its skills (`available_commands_update`) and `/compare` lands both prior dates on the
 * COMPARISON line.
 * Stage 3 (slice 5): the agent advertises `flags` (Level 2) and `/qa`; on the CT whole-abdomen
 * case with a planted laterality discrepancy, `/qa` raises a `_rad/flag` of kind `discrepancy`
 * and writes nothing; back on the brain session (impression drafted, no discussed-with line),
 * `/qa` raises `critical_uncommunicated`. Flag checks use `some`, never exact counts.
 * Stage 4 (slice 6): the provider switch is plain ACP — `session/new` advertises a `model`
 * select in `configOptions`, `session/set_config_option` re-picks the current value (the agent
 * graph is rebuilt) and a prompt on the rebuilt session still ends with `end_turn`.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { FLAG_METHOD, RadError, canonicalize, createReportStore, markdownToDelta, sliceLines, zFlagParams, type Op } from "acp-rad";

const url = process.env.BRIDGE_URL ?? "ws://localhost:8787/acp?agent=rad";
const ACCESSION = "ACC0000001";
const CHEST_ACCESSION = "ACC0000012";
const STONE_ACCESSION = "ACC0000031";
const here = path.dirname(fileURLToPath(import.meta.url));
const FX = path.resolve(here, "../../editor/fixtures");
const read = (rel: string) => readFileSync(path.join(FX, rel), "utf8");
const collection = (dir: string) =>
  Object.fromEntries(
    readdirSync(path.join(FX, dir))
      .filter((f) => f.endsWith(".md"))
      .map((f) => [f.replace(/\.md$/, ""), read(`${dir}/${f}`)]),
  );

/** One case's live buffer + store, the way the editor holds them. */
function caseStore(caseId: string, accession: string, start: (md: string) => string = (md) => md) {
  let ops: Op[] = markdownToDelta(start(read(`${caseId}/report.md`)));
  const priorsDir = path.join(FX, caseId, "priors");
  let priors: Record<string, string> = {};
  let priorsIndex: string | undefined;
  try {
    for (const f of readdirSync(priorsDir).filter((f) => f.endsWith(".md"))) {
      if (f === "index.md") priorsIndex = read(`${caseId}/priors/${f}`);
      else priors[f.replace(/\.md$/, "")] = read(`${caseId}/priors/${f}`);
    }
  } catch {
    priors = {};
  }
  const store = createReportStore({
    accession,
    getOps: () => ops,
    meta: JSON.parse(read(`${caseId}/meta.json`)) as Record<string, unknown>,
    priors,
    ...(priorsIndex !== undefined ? { priorsIndex } : {}),
    templates: collection("templates"),
    snippets: collection("snippets"),
  });
  return { store, setOps: (next: Op[]) => (ops = next) };
}

// Start state like the editor's demo: impression blanked so there is something to draft.
const brain = caseStore("ct-brain-er-stroke", ACCESSION, (md) => md.replace(/(\*\*IMPRESSION:\*\*\n)[\s\S]*$/, "$1- ...\n"));
const chest = caseStore("ct-chest-er-nodule-prior", CHEST_ACCESSION);
const stone = caseStore("ct-wa-er-stone", STONE_ACCESSION);
let active = brain;
const store = { read: (p: string) => active.store.read(p), assertWritable: (p: string) => active.store.assertWritable(p), reportMarkdown: () => active.store.reportMarkdown() };

const counts = { fsRead: 0, fsWrite: 0, readToolCalls: 0, editToolCalls: 0, diffs: 0, permissions: 0 };
const offered: string[][] = [];
let advertised: string[] = [];
let flags: { kind: string; summary: string }[] = [];
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
    } else if (u.sessionUpdate === "available_commands_update") {
      advertised = u.availableCommands.map((c) => c.name);
      say(`[available_commands_update] ${advertised.join(", ")}`);
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
      active.setOps(markdownToDelta(ctx.params.content));
    } else {
      active.setOps(markdownToDelta(store.reportMarkdown().replace(current, canonicalize(ctx.params.content))));
    }
    return { _meta: { rad: { outcome: "applied" } } };
  })
  .onRequest(FLAG_METHOD, zFlagParams, (ctx) => {
    // The Client acknowledges on receipt (slice 5); the smoke just records the flag.
    flags.push({ kind: ctx.params.kind, summary: ctx.params.summary });
    say(`[_rad/flag] ${ctx.params.kind}: ${ctx.params.summary} @ ${JSON.stringify(ctx.params.locations)}`);
    return { outcome: "acknowledged" as const };
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

  const manifest = active.store.manifest();
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

  const prompt = async (label: string, t: string, sessionId = session.sessionId) => {
    text = "";
    const r = await conn.agent.request(acp.methods.agent.session.prompt, {
      sessionId,
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

  // Stage 2 — a second session on the CT chest case: skills advertised, /compare lands both dates.
  active = chest;
  const chestManifest = chest.store.manifest();
  const chestSession = await conn.agent.request(acp.methods.agent.session.new, {
    cwd: `/worklist/${CHEST_ACCESSION}`,
    mcpServers: [],
    _meta: {
      rad: {
        accession: CHEST_ACCESSION,
        modality: "CT",
        region: "chest",
        protocol: "contrast",
        setting: "ER",
        reportStatus: "draft",
        shortPrelim: false,
        phiBoundary: "research_synthetic",
        manifest: chestManifest,
      },
    },
  });
  say(`[session 2] ${chestSession.sessionId} manifest=${chestManifest.length} files (${Object.keys(chest.store).length})`);
  await new Promise((r) => setTimeout(r, 200)); // the advertisement follows the response
  const r4 = await prompt("prompt 4", "/compare", chestSession.sessionId);
  const comparison = store.read(`/worklist/${CHEST_ACCESSION}/sections/comparison.md`);
  say(`[comparison after] ${JSON.stringify(comparison)}`);

  // Stage 3 — /qa: flags, never edits. First the planted discrepancy, then the brain session
  // whose impression the smoke drafted without a discussed-with line.
  active = stone;
  const stoneManifest = stone.store.manifest();
  const stoneSession = await conn.agent.request(acp.methods.agent.session.new, {
    cwd: `/worklist/${STONE_ACCESSION}`,
    mcpServers: [],
    _meta: {
      rad: {
        accession: STONE_ACCESSION,
        modality: "CT",
        region: "abdomen",
        protocol: "contrast",
        setting: "ER",
        reportStatus: "draft",
        shortPrelim: false,
        phiBoundary: "research_synthetic",
        manifest: stoneManifest,
      },
    },
  });
  say(`[session 3] ${stoneSession.sessionId} manifest=${stoneManifest.length} files`);
  await new Promise((r) => setTimeout(r, 200));
  const qaAdvertised = advertised.includes("qa");
  const writesBefore = counts.fsWrite;
  const editsBefore = counts.editToolCalls;
  flags = [];
  const r5 = await prompt("prompt 5", "/qa", stoneSession.sessionId);
  const stoneFlags = [...flags];
  active = brain;
  flags = [];
  const r6 = await prompt("prompt 6", "/qa", session.sessionId);
  const brainFlags = [...flags];
  say(`[flags] stone=${JSON.stringify(stoneFlags.map((f) => f.kind))} brain=${JSON.stringify(brainFlags.map((f) => f.kind))}`);

  // Stage 4 — the provider switch is plain ACP: session/new advertises a `model` select,
  // session/set_config_option picks one (the agent is rebuilt), and the session keeps working.
  const modelOption = (stoneSession.configOptions ?? []).find((o) => o.id === "model");
  const modelOptionAdvertised = modelOption?.type === "select";
  let setModelAccepted = false;
  let r7: acp.PromptResponse | undefined;
  if (modelOption?.type === "select") {
    say(`[model] current=${modelOption.currentValue} options=${JSON.stringify(modelOption.options.map((o) => ("value" in o ? o.value : "<group>")))}`);
    const res = await conn.agent.request(acp.methods.agent.session.setConfigOption, {
      sessionId: stoneSession.sessionId,
      configId: "model",
      value: modelOption.currentValue,
    });
    setModelAccepted = res.configOptions.some((o) => o.id === "model" && o.type === "select" && o.currentValue === modelOption.currentValue);
    active = stone;
    r7 = await prompt("prompt 7", "Reply with the single word PONG.", stoneSession.sessionId);
  }

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
    skillsAdvertised: ["compare", "impression", "proofread"].every((n) => advertised.includes(n)),
    compareLanded: comparison.includes("12/06/2025") && comparison.includes("20/02/2026") && !comparison.includes("____"),
    compareEndTurn: r4.stopReason === "end_turn",
    flagsCapAdvertised: (radCaps as { flags?: boolean } | undefined)?.flags === true,
    qaAdvertised,
    discrepancyFlagged: stoneFlags.some((f) => f.kind === "discrepancy"),
    criticalUncommunicatedFlagged: brainFlags.some((f) => f.kind === "critical_uncommunicated"),
    qaNoWrites: counts.fsWrite === writesBefore && counts.editToolCalls === editsBefore,
    qaEndTurn: r5.stopReason === "end_turn" && r6.stopReason === "end_turn",
    modelOptionAdvertised,
    setModelAccepted,
    promptAfterSwitch: r7?.stopReason === "end_turn",
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
