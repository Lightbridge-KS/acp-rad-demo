import type Quill from "quill";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { zRadSessionMeta } from "acp-rad";
import { connectAgent, type AgentHandle } from "./agent/connection.ts";
import { agentReducer, initialAgentState } from "./agent/store.ts";
import { ReportEditor } from "./report/ReportEditor.tsx";
import { Sidebar } from "./sidebar/Sidebar.tsx";
import reportText from "../fixtures/ct-brain-er-stroke/report.md?raw";
import reportMeta from "../fixtures/ct-brain-er-stroke/meta.json";

const BRIDGE_URL: string =
  (import.meta.env.VITE_BRIDGE_URL as string | undefined) ?? "ws://localhost:8787/acp?agent=rad";

const session = zRadSessionMeta.parse(reportMeta.session);

export default function App() {
  const [state, dispatch] = useReducer(agentReducer, initialAgentState);
  const agentRef = useRef<AgentHandle | null>(null);
  const quillRef = useRef<Quill | null>(null);

  useEffect(() => {
    let cancelled = false;
    dispatch({ type: "status", status: "connecting" });
    connectAgent(BRIDGE_URL, session, {
      onUpdate: (u) => {
        if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") {
          dispatch({ type: "chunk", role: "agent", text: u.content.text });
        } else if (u.sessionUpdate === "agent_thought_chunk" && u.content.type === "text") {
          dispatch({ type: "chunk", role: "thought", text: u.content.text });
        } else {
          dispatch({ type: "system", text: `↳ ${u.sessionUpdate}` });
        }
      },
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
        dispatch({
          type: "initialized",
          agentName: handle.agentName,
          level: handle.level,
          model: handle.model,
        });
        dispatch({ type: "session", sessionId: handle.sessionId });
        dispatch({ type: "system", text: `session ${handle.sessionId.slice(0, 8)} · ${session.accession}` });
      })
      .catch((err: unknown) => {
        dispatch({ type: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
      agentRef.current?.close();
      agentRef.current = null;
    };
  }, []);

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
        <span className="text-gray-500">{reportMeta.title}</span>
        <span className="ml-auto rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
          {session.reportStatus} · {session.phiBoundary}
        </span>
      </header>
      <main className="min-h-0 overflow-hidden">
        <ReportEditor
          key={session.accession}
          initialText={reportText}
          onReady={(q) => {
            quillRef.current = q;
          }}
        />
      </main>
      <Sidebar state={state} onSend={send} onStop={stop} />
    </div>
  );
}
