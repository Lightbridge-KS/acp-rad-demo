/**
 * The sidebar's message model, reduced directly from ACP `session/update`s (ADR 0001).
 * Tool calls live inside `parts` so text · tool · text ordering is preserved. The trailing
 * assistant message is replaced by a NEW object on every change — assistant-ui's converter
 * cache is keyed on message identity.
 */
import type * as acp from "@agentclientprotocol/sdk";

export type PermissionOption = { optionId: string; name: string; kind: string };

export type Permission = {
  options: PermissionOption[];
  /** Filled by the EDITOR (tracked-changes accept/discard), never by the sidebar. */
  outcome?: { optionId: string } | { cancelled: true };
};

export type Diff = { path: string; oldText: string | null; newText: string };

export type ToolCall = {
  toolCallId: string;
  title: string;
  kind?: string;
  status: string; // acp.ToolCallStatus, kept open for unknown values
  diff?: Diff;
  permission?: Permission;
};

export type Part =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; call: ToolCall };

export type AcpMessage =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; parts: Part[]; stopReason?: string };

export type SidebarState = {
  messages: AcpMessage[];
  isRunning: boolean;
  plan: { content: string; status: string }[];
  commands: string[];
  unknown: string[];
};

export type SidebarAction =
  | { type: "user"; text: string }
  | { type: "update"; update: acp.SessionUpdate }
  | { type: "permission_requested"; toolCallId: string; options: PermissionOption[] }
  | { type: "permission_resolved"; toolCallId: string; optionId: string }
  | { type: "permission_cancelled"; toolCallId: string }
  | { type: "turn_end"; stopReason: string }
  | { type: "reset" };

export const initialSidebarState: SidebarState = { messages: [], isRunning: false, plan: [], commands: [], unknown: [] };

let seq = 0;
const nextId = () => `m${++seq}`;

export function sidebarReducer(state: SidebarState, action: SidebarAction): SidebarState {
  switch (action.type) {
    case "reset":
      return initialSidebarState;
    case "user":
      return { ...state, isRunning: true, messages: [...state.messages, { id: nextId(), role: "user", text: action.text }] };
    case "update":
      return applyUpdate(state, action.update);
    case "permission_requested":
      return patchTool(state, action.toolCallId, (c) => ({ ...c, permission: { options: action.options } }));
    case "permission_resolved":
      return patchTool(state, action.toolCallId, (c) => ({
        ...c,
        permission: { options: c.permission?.options ?? [], outcome: { optionId: action.optionId } },
      }));
    case "permission_cancelled":
      return patchTool(state, action.toolCallId, (c) => ({
        ...c,
        permission: { options: c.permission?.options ?? [], outcome: { cancelled: true } },
      }));
    case "turn_end":
      return withAssistant({ ...state, isRunning: false }, (m) => ({ ...m, stopReason: action.stopReason }));
  }
}

function applyUpdate(state: SidebarState, u: acp.SessionUpdate): SidebarState {
  switch (u.sessionUpdate) {
    case "agent_message_chunk":
      return u.content.type === "text" ? appendText(state, "text", u.content.text) : state;
    case "agent_thought_chunk":
      return u.content.type === "text" ? appendText(state, "reasoning", u.content.text) : state;
    case "tool_call": {
      const call: ToolCall = {
        toolCallId: u.toolCallId,
        title: u.title,
        kind: u.kind ?? undefined,
        status: u.status ?? "pending",
        diff: diffOf(u.content),
      };
      return withAssistant(state, (m) => ({ ...m, parts: [...m.parts, { type: "tool", call }] }));
    }
    case "tool_call_update":
      return patchTool(state, u.toolCallId, (c) => ({
        ...c,
        title: u.title ?? c.title,
        kind: u.kind ?? c.kind,
        status: u.status ?? c.status,
        diff: diffOf(u.content) ?? c.diff,
      }));
    case "plan":
      return { ...state, plan: u.entries.map((e) => ({ content: e.content, status: e.status })) };
    case "available_commands_update":
      return { ...state, commands: u.availableCommands.map((c) => c.name) };
    default:
      return { ...state, unknown: [...state.unknown, (u as { sessionUpdate: string }).sessionUpdate] };
  }
}

export function diffOf(content: unknown): Diff | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const c of content as Array<{ type?: string; path?: string; oldText?: string | null; newText?: string }>) {
    if (c && c.type === "diff" && typeof c.path === "string" && typeof c.newText === "string") {
      return { path: c.path, oldText: c.oldText ?? null, newText: c.newText };
    }
  }
  return undefined;
}

function appendText(state: SidebarState, type: "text" | "reasoning", text: string): SidebarState {
  return withAssistant(state, (m) => {
    const last = m.parts[m.parts.length - 1];
    if (last && last.type === type) {
      return { ...m, parts: [...m.parts.slice(0, -1), { type, text: last.text + text }] };
    }
    return { ...m, parts: [...m.parts, { type, text }] };
  });
}

/** Replace the trailing assistant message (creating one if the tail is a user message). */
function withAssistant(
  state: SidebarState,
  fn: (m: Extract<AcpMessage, { role: "assistant" }>) => Extract<AcpMessage, { role: "assistant" }>,
): SidebarState {
  const last = state.messages[state.messages.length - 1];
  if (last && last.role === "assistant") {
    return { ...state, messages: [...state.messages.slice(0, -1), fn({ ...last })] };
  }
  return { ...state, messages: [...state.messages, fn({ id: nextId(), role: "assistant", parts: [] })] };
}

function patchTool(state: SidebarState, toolCallId: string, fn: (c: ToolCall) => ToolCall): SidebarState {
  let changed = false;
  const messages = state.messages.map((m) => {
    if (m.role !== "assistant") return m;
    const parts = m.parts.map((p) => {
      if (p.type !== "tool" || p.call.toolCallId !== toolCallId) return p;
      changed = true;
      return { type: "tool" as const, call: fn(p.call) };
    });
    return changed ? { ...m, parts } : m;
  });
  return changed ? { ...state, messages } : state;
}

/** Every tool call across the transcript (for the audit/decision panel). */
export function toolCalls(state: SidebarState): ToolCall[] {
  return state.messages.flatMap((m) => (m.role === "assistant" ? m.parts.filter((p) => p.type === "tool").map((p) => (p as { call: ToolCall }).call) : []));
}
