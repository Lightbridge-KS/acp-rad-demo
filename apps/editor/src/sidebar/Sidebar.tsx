import { useState, type FormEvent } from "react";
import type { AgentState, AgentStatus, ToolCard, TranscriptEntry } from "../agent/store.ts";

type Props = {
  state: AgentState;
  onSend: (text: string) => void;
  onStop: () => void;
};

const STATUS_DOT: Record<AgentStatus, string> = {
  disconnected: "bg-gray-400",
  connecting: "bg-amber-400 animate-pulse",
  ready: "bg-emerald-500",
  prompting: "bg-sky-500 animate-pulse",
  error: "bg-red-500",
};

const KIND_ICON: Record<string, string> = {
  read: "📄",
  edit: "✏️",
  search: "🔍",
  execute: "⚙️",
  think: "💭",
  fetch: "🌐",
};

export function Sidebar({ state, onSend, onStop }: Props) {
  const [draft, setDraft] = useState("");
  const busy = state.status === "prompting";
  const canSend = state.status === "ready" && draft.trim().length > 0;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSend) return;
    onSend(draft.trim());
    setDraft("");
  };

  return (
    <aside className="flex h-full flex-col border-l border-gray-200 bg-gray-50">
      <header className="flex items-center gap-2 border-b border-gray-200 px-3 py-2 text-sm">
        <span className={`inline-block h-2.5 w-2.5 rounded-full ${STATUS_DOT[state.status]}`} />
        <span className="font-medium">{state.agentName ?? "agent"}</span>
        {state.level !== undefined && (
          <span className="rounded bg-gray-200 px-1.5 py-0.5 text-xs">L{state.level}</span>
        )}
        {state.model && <span className="text-xs text-gray-500">· {state.model}</span>}
        <span className="ml-auto text-xs text-gray-500">{state.status}</span>
      </header>

      <ol className="flex-1 space-y-2 overflow-y-auto px-3 py-3 text-sm">
        {state.transcript.map((t) => (
          <Bubble key={t.id} entry={t} tools={state.tools} />
        ))}
        {state.error && <li className="text-red-600">{state.error}</li>}
      </ol>

      <form onSubmit={submit} className="border-t border-gray-200 p-2">
        <textarea
          className="h-20 w-full resize-none rounded border border-gray-300 p-2 text-sm"
          placeholder="Ask the agent… (Enter to send, Shift+Enter for newline)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) submit(e);
          }}
          disabled={state.status !== "ready"}
        />
        <div className="mt-1 flex justify-end gap-2">
          {busy ? (
            <button type="button" onClick={onStop} className="rounded bg-red-600 px-3 py-1 text-sm text-white">
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!canSend}
              className="rounded bg-sky-600 px-3 py-1 text-sm text-white disabled:opacity-40"
            >
              Send
            </button>
          )}
        </div>
      </form>
    </aside>
  );
}

function Bubble({ entry, tools }: { entry: TranscriptEntry; tools: Record<string, ToolCard> }) {
  switch (entry.role) {
    case "user":
      return <li className="ml-6 rounded-lg bg-sky-100 px-3 py-2 whitespace-pre-wrap">{entry.text}</li>;
    case "agent":
      return <li className="mr-6 rounded-lg bg-white px-3 py-2 whitespace-pre-wrap shadow-sm">{entry.text}</li>;
    case "thought":
      return (
        <li className="mr-6">
          <details className="rounded-lg bg-gray-100 px-3 py-1 text-xs text-gray-600">
            <summary className="cursor-pointer">thinking…</summary>
            <p className="whitespace-pre-wrap pt-1">{entry.text}</p>
          </details>
        </li>
      );
    case "tool": {
      const card = tools[entry.toolCallId];
      if (!card) return null;
      return (
        <li className="mr-6 flex items-center gap-2 rounded border border-gray-200 bg-white px-2 py-1 font-mono text-xs">
          <span>{KIND_ICON[card.kind ?? ""] ?? "▸"}</span>
          <span className="truncate" title={card.title}>
            {card.title}
          </span>
          <span className={`ml-auto ${card.status === "completed" ? "text-emerald-600" : card.status === "failed" ? "text-red-600" : "text-gray-400"}`}>
            {card.status ?? "…"}
          </span>
        </li>
      );
    }
    case "system":
      return <li className="text-center text-xs text-gray-500">{entry.text}</li>;
  }
}
