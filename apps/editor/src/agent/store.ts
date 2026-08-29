import type { ProfileLevel } from "acp-rad";

export type AgentStatus = "disconnected" | "connecting" | "ready" | "prompting" | "error";

export type ToolCard = {
  toolCallId: string;
  title: string;
  kind?: string;
  status?: string;
};

export type TranscriptEntry =
  | { id: number; role: "user" | "agent" | "thought" | "system"; text: string }
  | { id: number; role: "tool"; toolCallId: string };

export type AgentState = {
  status: AgentStatus;
  agentName?: string;
  level?: ProfileLevel;
  model?: string;
  sessionId?: string;
  transcript: TranscriptEntry[];
  tools: Record<string, ToolCard>;
  error?: string;
};

export type AgentAction =
  | { type: "status"; status: AgentStatus }
  | { type: "initialized"; agentName: string; level: ProfileLevel; model?: string }
  | { type: "session"; sessionId: string }
  | { type: "user"; text: string }
  | { type: "chunk"; role: "agent" | "thought"; text: string }
  | { type: "tool_call"; card: ToolCard }
  | { type: "tool_call_update"; toolCallId: string; patch: Partial<ToolCard> }
  | { type: "system"; text: string }
  | { type: "error"; message: string };

export const initialAgentState: AgentState = { status: "disconnected", transcript: [], tools: {} };

let nextId = 1;
const textEntry = (role: "user" | "agent" | "thought" | "system", text: string): TranscriptEntry => ({
  id: nextId++,
  role,
  text,
});

export function agentReducer(state: AgentState, action: AgentAction): AgentState {
  switch (action.type) {
    case "status":
      return { ...state, status: action.status };
    case "initialized":
      return { ...state, agentName: action.agentName, level: action.level, model: action.model };
    case "session":
      return { ...state, sessionId: action.sessionId, status: "ready" };
    case "user":
      return { ...state, status: "prompting", transcript: [...state.transcript, textEntry("user", action.text)] };
    case "chunk": {
      // Consecutive chunks of the same role merge into one bubble.
      const last = state.transcript.at(-1);
      if (last && last.role === action.role) {
        const merged = { ...last, text: last.text + action.text };
        return { ...state, transcript: [...state.transcript.slice(0, -1), merged] };
      }
      return { ...state, transcript: [...state.transcript, textEntry(action.role, action.text)] };
    }
    case "tool_call": {
      const id = action.card.toolCallId;
      const known = id in state.tools;
      return {
        ...state,
        tools: { ...state.tools, [id]: { ...state.tools[id], ...action.card } },
        transcript: known ? state.transcript : [...state.transcript, { id: nextId++, role: "tool", toolCallId: id }],
      };
    }
    case "tool_call_update": {
      const prev = state.tools[action.toolCallId] ?? { toolCallId: action.toolCallId, title: "…" };
      const patch = Object.fromEntries(Object.entries(action.patch).filter(([, v]) => v != null));
      const known = action.toolCallId in state.tools;
      return {
        ...state,
        tools: { ...state.tools, [action.toolCallId]: { ...prev, ...patch } },
        transcript: known
          ? state.transcript
          : [...state.transcript, { id: nextId++, role: "tool", toolCallId: action.toolCallId }],
      };
    }
    case "system":
      return { ...state, transcript: [...state.transcript, textEntry("system", action.text)] };
    case "error":
      return { ...state, status: "error", error: action.message };
  }
}
