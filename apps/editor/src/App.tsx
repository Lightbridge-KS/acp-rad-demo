import type Quill from "quill";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { markdownToDelta, type AuditRecord } from "acp-rad";
import { connectAgent, type AgentHandle } from "./agent/connection.ts";
import { AuditLog } from "./audit/log.ts";
import { defaultCase } from "./fixtures/index.ts";
import { HunkControls } from "./report/HunkControls.tsx";
import { ReportEditor } from "./report/ReportEditor.tsx";
import { clearAllUnreviewed, decideHunkOps, discardHunksOps, overlayOps, unreviewedLineCount } from "./report/overlay.ts";
import { applyOps, currentOps } from "./report/overlayQuill.ts";
import { ProposalStore, type Proposal, type Verb } from "./report/proposals.ts";
import { makeReportStore } from "./report/reportStore.ts";
import { Sidebar, type AgentPort, type HeaderState } from "./sidebar/Sidebar.tsx";
import { diffOf, initialSidebarState, sidebarReducer } from "./sidebar/store.ts";

const BRIDGE_URL: string =
  (import.meta.env.VITE_BRIDGE_URL as string | undefined) ?? "ws://localhost:8787/acp?agent=rad";

export default function App() {
  const fixture = defaultCase;
  const [state, dispatch] = useReducer(sidebarReducer, initialSidebarState);
  const [header, setHeader] = useState<HeaderState>({ status: "disconnected" });
  const [quill, setQuill] = useState<Quill | null>(null);
  const [proposalList, setProposalList] = useState<Proposal[]>([]);
  const [auditRecords, setAuditRecords] = useState<AuditRecord[]>([]);
  const [unreviewedCount, setUnreviewedCount] = useState(0);
  const agentRef = useRef<AgentHandle | null>(null);
  const initialOps = useMemo(() => markdownToDelta(fixture.reportMarkdown), [fixture]);
  const proposals = useMemo(() => new ProposalStore(fixture.session.accession), [fixture]);
  const audit = useMemo(() => new AuditLog(), [fixture]);

  // Render a proposal as tracked changes; report anchors that could not be found.
  const renderProposal = useCallback(
    (p: Proposal) => {
      if (!quill) return;
      const { ops, conflicts } = overlayOps(currentOps(quill), p.section, p.hunks);
      applyOps(quill, ops);
      if (conflicts.length) proposals.markConflicts(p.toolCallId, conflicts);
    },
    [quill, proposals],
  );

  // ProposalStore events → Quill, sidebar mirror, audit.
  useEffect(() => {
    const refresh = () => setProposalList(proposals.list());
    return proposals.subscribe((e) => {
      switch (e.type) {
        case "proposed":
          audit.record("proposal.received", { toolCallId: e.proposal.toolCallId, path: e.proposal.path, outcome: `${e.proposal.hunks.length} hunks` });
          break;
        case "decided":
          if (quill) applyOps(quill, decideHunkOps(currentOps(quill), e.hunkId, e.verb, e.proposal.toolCallId));
          audit.record(`hunk.${e.verb}`, { toolCallId: e.proposal.toolCallId, hunkId: e.hunkId, path: e.proposal.path });
          break;
        case "answered":
          if (e.answer.outcome === "selected") dispatch({ type: "permission_resolved", toolCallId: e.proposal.toolCallId, optionId: e.answer.optionId });
          else dispatch({ type: "permission_cancelled", toolCallId: e.proposal.toolCallId });
          break;
        case "cancelled":
          if (quill) applyOps(quill, discardHunksOps(currentOps(quill), e.proposal.hunks.map((h) => h.id)));
          dispatch({ type: "permission_cancelled", toolCallId: e.proposal.toolCallId });
          break;
        case "write":
          break;
      }
      if (quill) setUnreviewedCount(unreviewedLineCount(currentOps(quill)));
      refresh();
    });
  }, [proposals, audit, quill]);

  useEffect(() => audit.subscribe(() => setAuditRecords([...audit.records])), [audit]);

  // Connect once the editor exists: the ReportStore serves fs/* from live Quill state.
  useEffect(() => {
    if (!quill) return;
    let cancelled = false;
    const store = makeReportStore(quill, fixture);
    setHeader({ status: "connecting" });
    dispatch({ type: "reset" });
    connectAgent(BRIDGE_URL, fixture.session, store, proposals, audit, {
      onUpdate: (u) => {
        dispatch({ type: "update", update: u });
        // A diff on an edit tool call becomes a proposal the moment it arrives (before the permission request).
        if ((u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") && !proposals.get(u.toolCallId)) {
          const diff = diffOf(u.content);
          if (diff) {
            const p = safe(() => proposals.fromDiff(u.toolCallId, diff, store.read(diff.path)));
            if (p) renderProposal(p);
          } else if (u.sessionUpdate === "tool_call_update" && u.kind === "edit") {
            const raw = u.rawInput as { file_path?: string; content?: string } | undefined;
            if (raw?.file_path && typeof raw.content === "string") {
              const p = safe(() => proposals.fromWrite(u.toolCallId, raw.file_path!, raw.content!, store.read(raw.file_path!)));
              if (p) renderProposal(p);
            }
          }
        }
      },
      onPermission: (toolCallId, options) => dispatch({ type: "permission_requested", toolCallId, options }),
      onUnsolicited: (p) => {
        renderProposal(p);
      },
      onClosed: (reason) => {
        if (cancelled) return; // this effect's own teardown (e.g. StrictMode's first mount)
        agentRef.current = null;
        setHeader((h) => ({ ...h, status: "disconnected", error: reason }));
      },
    })
      .then((handle) => {
        if (cancelled) {
          handle.close();
          return;
        }
        agentRef.current = handle;
        setHeader({ status: "ready", agentName: handle.agentName, level: handle.level, model: handle.model });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setHeader({ status: "error", error: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
      agentRef.current?.close();
      agentRef.current = null;
    };
  }, [quill, fixture, proposals, audit, renderProposal]);

  const agentPort = useMemo<AgentPort | null>(
    () =>
      header.status === "ready"
        ? {
            prompt: async (text) => {
              const agent = agentRef.current;
              if (!agent) return;
              try {
                const res = await agent.prompt(text);
                dispatch({ type: "turn_end", stopReason: res.stopReason });
              } catch (err) {
                dispatch({ type: "turn_end", stopReason: "error" });
                setHeader((h) => ({ ...h, error: err instanceof Error ? err.message : String(err) }));
              }
            },
            cancel: async () => {
              await agentRef.current?.cancel();
            },
          }
        : null,
    [header.status],
  );

  const decide = useCallback((toolCallId: string, hunkId: string, verb: Verb) => proposals.decide(toolCallId, hunkId, verb), [proposals]);
  const pending = proposalList.filter((p) => p.state === "pending");
  const pendingHunks = pending.reduce((n, p) => n + p.hunks.filter((h) => p.states[h.id] === "pending").length, 0);

  return (
    <div className="grid h-full grid-cols-[minmax(0,1fr)_400px] grid-rows-[auto_minmax(0,1fr)]">
      <header className="col-span-2 flex items-center gap-3 border-b border-gray-200 px-4 py-2 text-sm">
        <span className="font-semibold">ACP-Rad</span>
        <span className="text-gray-500">{fixture.title}</span>
        <span className="text-xs text-gray-400">{fixture.session.accession}</span>
        <span className="ml-auto flex items-center gap-2 text-xs">
          {pendingHunks > 0 && (
            <span className="flex items-center gap-2 rounded-full border border-emerald-500 bg-emerald-50 px-2 py-0.5">
              {pendingHunks} change{pendingHunks === 1 ? "" : "s"}
              <button type="button" className="font-medium underline" onClick={() => pending.forEach((p) => proposals.decideAll(p.toolCallId, "accept_edit"))}>
                Accept all for review
              </button>
              <button type="button" className="underline" onClick={() => pending.forEach((p) => proposals.decideAll(p.toolCallId, "reject"))}>
                Reject all
              </button>
            </span>
          )}
          {unreviewedCount > 0 && (
            <span className="flex items-center gap-2 rounded-full border border-amber-400 bg-amber-50 px-2 py-0.5">
              {unreviewedCount} unreviewed line{unreviewedCount === 1 ? "" : "s"}
              <button
                type="button"
                className="font-medium underline"
                onClick={() => {
                  if (!quill) return;
                  applyOps(quill, clearAllUnreviewed(currentOps(quill)));
                  audit.record("review.cleared", { outcome: "all" });
                  setUnreviewedCount(0);
                }}
              >
                Mark all reviewed
              </button>
            </span>
          )}
          <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-800">
            {fixture.session.reportStatus}
            {fixture.session.shortPrelim ? " · short prelim" : ""} · {fixture.session.phiBoundary}
          </span>
        </span>
      </header>
      <main className="min-h-0 overflow-hidden">
        <ReportEditor
          key={fixture.id}
          initialOps={initialOps}
          onReady={setQuill}
          onUserChange={(q) => {
            setUnreviewedCount(unreviewedLineCount(currentOps(q)));
          }}
          overlay={(q, tick) => <HunkControls quill={q} proposals={proposalList} tick={tick} onDecide={decide} />}
        />
      </main>
      <Sidebar state={state} dispatch={dispatch} header={header} agent={agentPort} audit={auditRecords} />
    </div>
  );
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
