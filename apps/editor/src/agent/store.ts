import type { ProfileLevel } from "acp-rad";

export type AgentStatus = "disconnected" | "connecting" | "ready" | "prompting" | "error";

export type TranscriptEntry = {
  id: number;
  role: "user" | "agent" | "thought" | "system";
  text: string;
};

export type AgentState = {
  status: AgentStatus;
  agentName?: string;
  level?: ProfileLevel;
  model?: string;
  sessionId?: string;
  transcript: TranscriptEntry[];
  error?: string;
};

export type AgentAction =
  | { type: "status"; status: AgentStatus }
  | { type: "initialized"; agentName: string; level: ProfileLevel; model?: string }
  | { type: "session"; sessionId: string }
  | { type: "user"; text: string }
  | { type: "chunk"; role: "agent" | "thought"; text: string }
  | { type: "system"; text: string }
  | { type: "error"; message: string };

export const initialAgentState: AgentState = { status: "disconnected", transcript: [] };

let nextId = 1;
const entry = (role: TranscriptEntry["role"], text: string): TranscriptEntry => ({
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
      return { ...state, status: "prompting", transcript: [...state.transcript, entry("user", action.text)] };
    case "chunk": {
      // Consecutive chunks of the same role merge into one bubble.
      const last = state.transcript.at(-1);
      if (last && last.role === action.role) {
        const merged = { ...last, text: last.text + action.text };
        return { ...state, transcript: [...state.transcript.slice(0, -1), merged] };
      }
      return { ...state, transcript: [...state.transcript, entry(action.role, action.text)] };
    }
    case "system":
      return { ...state, transcript: [...state.transcript, entry("system", action.text)] };
    case "error":
      return { ...state, status: "error", error: action.message };
  }
}
