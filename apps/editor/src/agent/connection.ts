/**
 * The editor's side of ACP. The browser IS the ACP Client: it connects over WebSocket
 * (bridge re-frames to the agent's stdio), negotiates the ACP-Rad profile through
 * `_meta.rad`, binds one session to one accession, serves the virtual namespace through
 * `fs/*` from the ReportStore, answers `session/request_permission` from the radiologist's
 * per-hunk decisions (ProposalStore), enforces the grant rule on writes, accepts `_rad/flag`
 * requests, and streams `session/update`s to the sidebar. Every consequential event is stamped
 * into the audit log.
 */
import * as acp from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import {
  FLAG_METHOD,
  PROFILE_VERSION,
  RAD_ERRORS,
  RAD_META_KEY,
  RadError,
  levelOf,
  readRadAgentCaps,
  sliceLines,
  worklistRoot,
  zFlagParams,
  type FlagParams,
  type ProfileLevel,
  type RadClientCaps,
  type RadSessionMeta,
  type RadWriteOutcome,
  type ReportStore,
} from "acp-rad";
import type { AuditLog } from "../audit/log.ts";
import { fingerprint } from "../audit/log.ts";
import { isQaPrompt } from "../report/lifecycle.ts";
import type { PermissionOption, Proposal, ProposalStore } from "../report/proposals.ts";

/**
 * Why the editor refuses an agent write outright (no proposal, no decision): the report is
 * `final` (design 02 §5.2), or the running turn is `/qa`, which never edits (04 §3.5).
 */
export type RefuseReason = "final" | "qa";

export const CLIENT_INFO = { name: "acp-rad-editor", version: "0.1.0" } as const;

/** What this editor implements of the profile (design §3.1). */
export const CLIENT_RAD_CAPS: RadClientCaps = {
  profileVersion: PROFILE_VERSION,
  focusState: true,
  flags: true,
  clinicalPermissionVerbs: true,
  codedContent: [],
};

/** Options the editor offers itself for an unsolicited write (no agent request preceded it). */
const LOCAL_OPTIONS: PermissionOption[] = [
  { optionId: "accept", name: "Accept", kind: "allow_once" },
  { optionId: "accept_edit", name: "Accept for review", kind: "allow_once" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
];

export type AgentEvents = {
  onUpdate: (update: acp.SessionUpdate) => void;
  onClosed: (reason: string) => void;
  onFsRead?: (path: string) => void;
  /** A permission request arrived for `toolCallId` with these (already filtered) options. */
  onPermission?: (toolCallId: string, options: PermissionOption[]) => void;
  /** An unsolicited write was turned into a proposal the editor must render. */
  onUnsolicited?: (proposal: Proposal) => void;
  /**
   * A `_rad/flag` request (design 04 §3.5). Called synchronously before the request is answered
   * `acknowledged`: the editor records the flag and marks its line; the radiologist's own
   * acknowledgement is a later, local act.
   */
  onFlag?: (params: FlagParams) => void;
};

export type AgentHandle = {
  sessionId: string;
  agentName: string;
  agentVersion?: string;
  level: ProfileLevel;
  model?: string;
  manifest: string[];
  /** One turn at a time: throws if a turn is already running. */
  prompt: (text: string) => Promise<acp.PromptResponse>;
  cancel: () => Promise<void>;
  close: () => void;
  /** Whether an agent edit would be refused right now — the editor must not render one as a proposal either. */
  refuseReason: () => RefuseReason | null;
  /** `session/new`'s `configOptions` (the `model` select when the agent offers one); later updates arrive as `config_option_update`. */
  configOptions: acp.SessionConfigOption[];
  /** `session/set_config_option`; resolves with the agent's updated options. */
  setConfigOption: (configId: string, value: string) => Promise<acp.SessionConfigOption[]>;
};

/** Run a ReportStore operation, translating profile errors to JSON-RPC errors on the wire. */
function guarded<T>(op: () => T): T {
  try {
    return op();
  } catch (err) {
    if (err instanceof RadError) throw new acp.RequestError(err.code, err.message);
    throw err;
  }
}

export async function connectAgent(
  url: string,
  session: RadSessionMeta,
  store: ReportStore,
  proposals: ProposalStore,
  audit: AuditLog,
  events: AgentEvents,
): Promise<AgentHandle> {
  const stream = createWebSocketStream(url);
  /** The prompt text of the turn in flight (`session/prompt` sent, response pending). */
  let activeTurn: string | null = null;
  const refuseReason = (): RefuseReason | null => (store.reportStatus() === "final" ? "final" : isQaPrompt(activeTurn) ? "qa" : null);
  const conn = acp
    .client({ name: CLIENT_INFO.name })
    .onNotification(acp.methods.client.session.update, (ctx) => events.onUpdate(ctx.params.update))
    .onRequest(acp.methods.client.fs.readTextFile, (ctx) => {
      const { path, line, limit } = ctx.params;
      // While a grant is open, the agent sees the section as it was shown it (design §5.7):
      // its read-modify-write then reproduces the proposed edit and the write lands as
      // applied/partial instead of failing to find `old_string` in the updated buffer.
      const grant = proposals.peekGrant(path);
      const content = grant ? grant.baseText : guarded(() => store.read(path));
      audit.record("fs.read", { path, ...(grant ? { outcome: "base-while-granted" } : {}) });
      events.onFsRead?.(path);
      return { content: sliceLines(content, line, limit) };
    })
    .onRequest(acp.methods.client.fs.writeTextFile, async (ctx) => {
      const { path, content } = ctx.params;
      const reason = refuseReason();
      if (reason) {
        audit.record("fs.write.refused", { path, outcome: reason });
        throw new acp.RequestError(RAD_ERRORS.FORBIDDEN, reason === "qa" ? "no edits during /qa — raise a flag instead" : "report is final");
      }
      guarded(() => store.assertWritable(path));
      const hash = fingerprint(content);

      const grant = proposals.takeGrant(path);
      if (grant) {
        const outcome = proposals.outcomeFor(grant, content);
        audit.record(`fs.write.${outcome}`, { path, toolCallId: grant.toolCallId, argsHash: hash, outcome });
        const meta: RadWriteOutcome = { outcome, toolCallId: grant.toolCallId, accepted: grant.accepted, discarded: grant.discarded };
        return { _meta: { [RAD_META_KEY]: meta } };
      }

      // Unsolicited (Level 0 agent, or a write nobody asked about): it becomes a proposal.
      const current = guarded(() => store.read(path));
      const id = `write-${Date.now().toString(36)}`;
      const proposal = proposals.fromWrite(id, path, content, current);
      if (!proposal) throw new acp.RequestError(RAD_ERRORS.NOT_FOUND, `not a report path: ${path}`);
      audit.record("fs.write.unsolicited", { path, toolCallId: id, argsHash: hash });
      if (proposal.hunks.length === 0) {
        return { _meta: { [RAD_META_KEY]: { outcome: "applied", toolCallId: id } satisfies RadWriteOutcome } };
      }
      events.onUnsolicited?.(proposal);
      const answer = await proposals.awaitPermission(id, LOCAL_OPTIONS);
      if (answer.outcome !== "selected" || answer.optionId === "reject") {
        audit.record("fs.write.rejected", { path, toolCallId: id });
        throw new acp.RequestError(RAD_ERRORS.PROPOSAL_REJECTED, "proposal discarded by the radiologist");
      }
      const g = proposals.takeGrant(path);
      const outcome = g ? proposals.outcomeFor(g, content) : "partial";
      audit.record(`fs.write.${outcome}`, { path, toolCallId: id, argsHash: hash, outcome });
      return { _meta: { [RAD_META_KEY]: { outcome, toolCallId: id } satisfies RadWriteOutcome } };
    })
    .onRequest(FLAG_METHOD, zFlagParams, (ctx) => {
      // The Client acknowledges on receipt (KS, 2026-08-30): the turn never waits for a human.
      events.onFlag?.(ctx.params);
      return { outcome: "acknowledged" as const };
    })
    .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
      const requestId = ctx.params.toolCall.toolCallId;
      const options: PermissionOption[] = ctx.params.options
        .filter((o) => o.kind !== "allow_always" && o.kind !== "reject_always") // INV-1
        .map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind }));
      audit.record("permission.request", { toolCallId: requestId });
      const raw = (ctx.params.toolCall.rawInput ?? {}) as { file_path?: string; old_string?: string; new_string?: string; content?: string };
      // A final report, or a /qa turn: the edit is refused before anyone is asked — the editor
      // answers the agent's own `reject` option so its loop resumes and the turn ends normally.
      const reason = refuseReason();
      if (reason) {
        const reject = ctx.params.options.find((o) => o.kind === "reject_once");
        audit.record("permission.refused", { toolCallId: requestId, ...(raw.file_path ? { path: raw.file_path } : {}), outcome: reason });
        return reject ? { outcome: { outcome: "selected" as const, optionId: reject.optionId } } : { outcome: { outcome: "cancelled" as const } };
      }
      // deepagents-acp mints a fresh id for the interrupt; fall back to matching the pending
      // proposal by the tool's raw input (path + old/new snippets).
      const proposal =
        proposals.get(requestId) ??
        (raw.file_path ? proposals.matchPending(raw.file_path, raw.old_string, raw.new_string ?? raw.content) : undefined);
      if (!proposal) {
        // No diff preceded this request (not an edit we can render) — nothing to decide in the report.
        audit.record("permission.unmatched", { toolCallId: requestId, outcome: "cancelled" });
        return { outcome: { outcome: "cancelled" as const } };
      }
      const toolCallId = proposal.toolCallId;
      events.onPermission?.(toolCallId, options);
      const answer = await proposals.awaitPermission(toolCallId, options);
      audit.record(answer.outcome === "selected" ? `permission.${answer.optionId}` : "permission.cancelled", { toolCallId, path: proposal.path });
      return answer.outcome === "selected"
        ? { outcome: { outcome: "selected" as const, optionId: answer.optionId } }
        : { outcome: { outcome: "cancelled" as const } };
    })
    .connect(stream);

  conn.closed.then(
    () => {
      proposals.cancelAll();
      events.onClosed("connection closed");
    },
    (err: unknown) => {
      proposals.cancelAll();
      events.onClosed(err instanceof Error ? err.message : String(err));
    },
  );

  const init = await conn.agent.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    clientInfo: { name: CLIENT_INFO.name, version: CLIENT_INFO.version },
    _meta: { [RAD_META_KEY]: CLIENT_RAD_CAPS } as Record<string, unknown>,
  });
  const level = levelOf(init._meta ?? undefined);
  const model = readRadAgentCaps(init._meta ?? undefined)?.model;
  const agentName = init.agentInfo?.name ?? "agent";
  const agentVersion = init.agentInfo?.version ?? undefined;

  const manifest = store.manifest();
  const created = await conn.agent.request(acp.methods.agent.session.new, {
    cwd: worklistRoot(session.accession),
    mcpServers: [],
    _meta: { [RAD_META_KEY]: { ...session, manifest } } as Record<string, unknown>,
  });
  const sessionId = created.sessionId;

  audit.bind(
    { sessionId, accession: session.accession, agent: { name: agentName, version: agentVersion, level } },
    (method, record) => void conn.agent.notify(method, record),
  );
  audit.record("session.new", { outcome: `manifest=${manifest.length}` });

  // Level 0 hygiene (spike 1b): never inherit a registry agent's host permission mode.
  const modes = created.modes?.availableModes?.map((m) => m.id) ?? [];
  if (created.modes && created.modes.currentModeId !== "default" && modes.includes("default")) {
    await conn.agent.request(acp.methods.agent.session.setMode, { sessionId, modeId: "default" }).catch(() => undefined);
    audit.record("session.set_mode", { outcome: "default" });
  }

  return {
    sessionId,
    agentName,
    agentVersion,
    level,
    model,
    manifest,
    prompt: async (text) => {
      if (activeTurn !== null) throw new Error("a turn is already running");
      activeTurn = text;
      try {
        return await conn.agent.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text }],
        });
      } finally {
        activeTurn = null;
      }
    },
    cancel: async () => {
      proposals.cancelAll(); // ACP: in-flight permission requests must be answered `cancelled`
      await conn.agent.notify(acp.methods.agent.session.cancel, { sessionId });
      audit.record("session.cancel");
    },
    close: () => conn.close(),
    refuseReason,
    configOptions: created.configOptions ?? [],
    setConfigOption: async (configId, value) => {
      const res = await conn.agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId, value });
      audit.record("session.config", { outcome: `${configId}=${value}` });
      return res.configOptions;
    },
  };
}
