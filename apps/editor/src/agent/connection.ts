/**
 * The editor's side of ACP. The browser IS the ACP Client: it connects over
 * WebSocket (bridge re-frames to the agent's stdio), negotiates the ACP-Rad
 * profile through `_meta.rad`, binds one session to one accession, serves the
 * virtual namespace through `fs/*` from the ReportStore, and streams
 * `session/update`s to the sidebar.
 *
 * Slice 2 scope: reads. `fs/write_text_file` is refused (-32003) until the
 * proposal flow lands in slice 3; `session/request_permission` is a placeholder.
 */
import * as acp from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import {
  PROFILE_VERSION,
  RAD_META_KEY,
  RadError,
  levelOf,
  readRadAgentCaps,
  sliceLines,
  worklistRoot,
  type ProfileLevel,
  type RadClientCaps,
  type RadSessionMeta,
  type ReportStore,
} from "acp-rad";

export const CLIENT_INFO = { name: "acp-rad-editor", version: "0.1.0" } as const;

/** What this editor implements of the profile (design §3.1). */
export const CLIENT_RAD_CAPS: RadClientCaps = {
  profileVersion: PROFILE_VERSION,
  focusState: true,
  criticalFindings: true,
  clinicalPermissionVerbs: true,
  codedContent: [],
};

export type AgentEvents = {
  onUpdate: (update: acp.SessionUpdate) => void;
  onClosed: (reason: string) => void;
  /** The editor served a file to the agent (for the sidebar's audit-style trace). */
  onFsRead?: (path: string) => void;
};

export type AgentHandle = {
  sessionId: string;
  agentName: string;
  level: ProfileLevel;
  /** Model reported by the agent in `_meta.rad.model`, if any. */
  model?: string;
  manifest: string[];
  prompt: (text: string) => Promise<acp.PromptResponse>;
  cancel: () => Promise<void>;
  close: () => void;
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
  events: AgentEvents,
): Promise<AgentHandle> {
  const stream = createWebSocketStream(url);
  const conn = acp
    .client({ name: CLIENT_INFO.name })
    .onNotification(acp.methods.client.session.update, (ctx) => events.onUpdate(ctx.params.update))
    .onRequest(acp.methods.client.fs.readTextFile, (ctx) => {
      const { path, line, limit } = ctx.params;
      const content = guarded(() => store.read(path));
      events.onFsRead?.(path);
      return { content: sliceLines(content, line, limit) };
    })
    .onRequest(acp.methods.client.fs.writeTextFile, (ctx) => {
      guarded(() => store.write(ctx.params.path, ctx.params.content));
      return {};
    })
    // Placeholder until slice 3 — the editor never grants anything it cannot show.
    .onRequest(acp.methods.client.session.requestPermission, () => ({
      outcome: { outcome: "cancelled" as const },
    }))
    .connect(stream);

  conn.closed.then(
    () => events.onClosed("connection closed"),
    (err: unknown) => events.onClosed(err instanceof Error ? err.message : String(err)),
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

  const manifest = store.manifest();
  const created = await conn.agent.request(acp.methods.agent.session.new, {
    cwd: worklistRoot(session.accession),
    mcpServers: [],
    _meta: { [RAD_META_KEY]: { ...session, manifest } } as Record<string, unknown>,
  });
  const sessionId = created.sessionId;

  return {
    sessionId,
    agentName,
    level,
    model,
    manifest,
    prompt: (text) =>
      conn.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text }],
      }),
    cancel: () => conn.agent.notify(acp.methods.agent.session.cancel, { sessionId }),
    close: () => conn.close(),
  };
}
