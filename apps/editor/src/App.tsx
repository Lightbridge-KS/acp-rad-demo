import type Quill from "quill";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { markdownToDelta } from "acp-rad";
import { connectAgent, type AgentHandle } from "./agent/connection.ts";
import { agentReducer, initialAgentState } from "./agent/store.ts";
import { defaultCase } from "./fixtures/index.ts";
import { ReportEditor } from "./report/ReportEditor.tsx";
import { makeReportStore } from "./report/reportStore.ts";
import { Sidebar } from "./sidebar/Sidebar.tsx";

const BRIDGE_URL: string =
  (import.meta.env.VITE_BRIDGE_URL as string | undefined) ?? "ws://localhost:8787/acp?agent=rad";

const shortPath = (p: string) => p.replace(/^\/worklist\/[^/]+\//, "");

export default function App() {
  const fixture = defaultCase;
  const [state, dispatch] = useReducer(agentReducer, initialAgentState);
  const [quill, setQuill] = useState<Quill | null>(null);
  const agentRef = useRef<AgentHandle | null>(null);
  const initialOps = useMemo(() => markdownToDelta(fixture.reportMarkdown), [fixture]);

  // Connect once the editor exists: the ReportStore serves fs/* from live Quill state.
  useEffect(() => {
    if (!quill) return;
    let cancelled = false;
    const store = makeReportStore(quill, fixture);
    dispatch({ type: "status", status: "connecting" });
    connectAgent(BRIDGE_URL, fixture.session, store, {
      onUpdate: (u) => {
        switch (u.sessionUpdate) {
          case "agent_message_chunk":
            if (u.content.type === "text") dispatch({ type: "chunk", role: "agent", text: u.content.text });
            break;
          case "agent_thought_chunk":
            if (u.content.type === "text") dispatch({ type: "chunk", role: "thought", text: u.content.text });
            break;
          case "tool_call":
            dispatch({
              type: "tool_call",
              card: { toolCallId: u.toolCallId, title: u.title, kind: u.kind ?? undefined, status: u.status ?? undefined },
            });
            break;
          case "tool_call_update":
            dispatch({
              type: "tool_call_update",
              toolCallId: u.toolCallId,
              patch: { title: u.title ?? undefined, kind: u.kind ?? undefined, status: u.status ?? undefined },
            });
            break;
          default:
            dispatch({ type: "system", text: `↳ ${u.sessionUpdate}` });
        }
      },
      onFsRead: (path) => dispatch({ type: "system", text: `⇢ served ${shortPath(path)}` }),
      onClosed: (reason) => {
        if (cancelled) return; // this effect's own teardown (e.g. StrictMode's first mount)
        agentRef.current = null;
        dispatch({ type: "status", status: "disconnected" });
        dispatch({ type: "system", text: `disconnected: ${reason}` });
      },
    })
      .then((handle) => {
        if (cancelled) {
          handle.close();
          return;
        }
        agentRef.current = handle;
        dispatch({ type: "initialized", agentName: handle.agentName, level: handle.level, model: handle.model });
        dispatch({ type: "session", sessionId: handle.sessionId });
        dispatch({
          type: "system",
          text: `session ${handle.sessionId.slice(0, 8)} · ${fixture.session.accession} · ${handle.manifest.length} files`,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        dispatch({ type: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
      agentRef.current?.close();
      agentRef.current = null;
    };
  }, [quill, fixture]);

  const send = useCallback((text: string) => {
    const agent = agentRef.current;
    if (!agent) return;
    dispatch({ type: "user", text });
    agent
      .prompt(text)
      .then((res) => {
        dispatch({ type: "system", text: `↩ ${res.stopReason}` });
        dispatch({ type: "status", status: "ready" });
      })
      .catch((err: unknown) => {
        dispatch({ type: "error", message: err instanceof Error ? err.message : String(err) });
      });
  }, []);

  const stop = useCallback(() => {
    void agentRef.current?.cancel();
  }, []);

  return (
    <div className="grid h-full grid-cols-[minmax(0,1fr)_380px] grid-rows-[auto_minmax(0,1fr)]">
      <header className="col-span-2 flex items-center gap-3 border-b border-gray-200 px-4 py-2 text-sm">
        <span className="font-semibold">ACP-Rad</span>
        <span className="text-gray-500">{fixture.title}</span>
        <span className="text-xs text-gray-400">{fixture.session.accession}</span>
        <span className="ml-auto rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
          {fixture.session.reportStatus} · {fixture.session.phiBoundary}
        </span>
      </header>
      <main className="min-h-0 overflow-hidden">
        <ReportEditor key={fixture.id} initialOps={initialOps} onReady={setQuill} />
      </main>
      <Sidebar state={state} onSend={send} onStop={stop} />
    </div>
  );
}
