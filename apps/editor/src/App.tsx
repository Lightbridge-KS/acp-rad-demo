import type Quill from "quill";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { canonicalLines, markdownToDelta, resolvePath, sectionIdOfLine, type AuditRecord, type FlagParams, type ReportStatus, type SectionId } from "acp-rad";
import { connectAgent, type AgentHandle } from "./agent/connection.ts";
import { AuditLog } from "./audit/log.ts";
import { applyEffect } from "./commands/apply.ts";
import { CommandsButton } from "./commands/CommandsButton.tsx";
import { isBlankApartFromSlash } from "./commands/document.ts";
import { listCommands, runEditorCommand, type Command, type CommandContext, type CommandGroups } from "./commands/registry.ts";
import { SlashMenu, caretAfter, transformRange, type Range } from "./commands/SlashMenu.tsx";
import { cases, defaultCase, snippets, templates, type CaseFixture } from "./fixtures/index.ts";
import { FlagStore, type Flag } from "./report/flags.ts";
import { HunkControls } from "./report/HunkControls.tsx";
import { ReportEditor } from "./report/ReportEditor.tsx";
import { clearAllUnreviewed, clearFlagOps, decideHunkOps, discardHunksOps, flagLineIndex, flagLineOps, isInsertLine, lineLength, lineText, overlayOps, splitLines, unreviewedLineCount } from "./report/overlay.ts";
import { applyOps, currentOps } from "./report/overlayQuill.ts";
import { ProposalStore, type Proposal, type Verb } from "./report/proposals.ts";
import { makeReportStore } from "./report/reportStore.ts";
import { Sidebar, type AgentPort, type HeaderState } from "./sidebar/Sidebar.tsx";
import { diffOf, initialSidebarState, sidebarReducer } from "./sidebar/store.ts";

const BRIDGE_URL: string =
  (import.meta.env.VITE_BRIDGE_URL as string | undefined) ?? "ws://localhost:8787/acp?agent=rad";

/** `?case=<id>` picks a fixture until the worklist lands (slice 6). */
function caseFromUrl(): CaseFixture {
  const id = new URLSearchParams(window.location.search).get("case");
  return cases.find((c) => c.id === id) ?? defaultCase;
}

export default function App() {
  const fixture = useMemo(caseFromUrl, []);
  const [state, dispatch] = useReducer(sidebarReducer, initialSidebarState);
  const [header, setHeader] = useState<HeaderState>({ status: "disconnected" });
  const [quill, setQuill] = useState<Quill | null>(null);
  const [proposalList, setProposalList] = useState<Proposal[]>([]);
  const [flagList, setFlagList] = useState<Flag[]>([]);
  const [auditRecords, setAuditRecords] = useState<AuditRecord[]>([]);
  const [unreviewedCount, setUnreviewedCount] = useState(0);
  const [hint, setHint] = useState<string | null>(null);
  // Report lifecycle (design 02 §5.2): status moves only by explicit acts (slice 6); the
  // short-prelim property is set by /short-prelim and cleared by the fold-in.
  const [status] = useState<ReportStatus>(fixture.session.reportStatus);
  const [shortPrelim, setShortPrelim] = useState<boolean>(fixture.session.shortPrelim);
  const statusRef = useRef(status);
  statusRef.current = status;
  // The caret, tracked from Quill events: `quill.getSelection()` runs `quill.update()` and may
  // emit a text-change, so it must never be called from render or a tick-dependent effect.
  const caretRef = useRef<Range | null>(null);
  useEffect(() => {
    if (!quill) return;
    const onSelection = (range: Range | null) => {
      if (range) caretRef.current = range;
    };
    const onText = (change: { ops: import("quill").Op[] }, _old: unknown, source: string) => {
      caretRef.current = source === "user" ? (caretAfter(change.ops) ?? caretRef.current) : transformRange(caretRef.current, change.ops);
    };
    quill.on("selection-change", onSelection);
    quill.on("text-change", onText);
    return () => {
      quill.off("selection-change", onSelection);
      quill.off("text-change", onText);
    };
  }, [quill]);
  const agentRef = useRef<AgentHandle | null>(null);
  const initialOps = useMemo(() => markdownToDelta(fixture.reportMarkdown), [fixture]);
  const proposals = useMemo(() => new ProposalStore(fixture.session.accession), [fixture]);
  // Flags belong to the radiologist once raised: per study, never cancelled by the agent's turn.
  const flags = useMemo(() => new FlagStore(), [fixture]);
  const audit = useMemo(() => new AuditLog(), [fixture]);
  // One ReportStore for the agent (fs/*) and the editor commands: live Quill, overlays stripped.
  const store = useMemo(() => (quill ? makeReportStore(quill, fixture, () => statusRef.current) : null), [quill, fixture]);

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
      const local = e.proposal.origin === "local";
      switch (e.type) {
        case "proposed":
          if (local) audit.record(`command.${e.proposal.local?.command ?? "?"}`, { toolCallId: e.proposal.toolCallId, path: e.proposal.path, outcome: `proposal · ${e.proposal.hunks.length} hunks` });
          else audit.record("proposal.received", { toolCallId: e.proposal.toolCallId, path: e.proposal.path, outcome: `${e.proposal.hunks.length} hunks` });
          break;
        case "decided":
          if (quill) applyOps(quill, decideHunkOps(currentOps(quill), e.hunkId, e.verb, e.proposal.toolCallId));
          audit.record(`hunk.${e.verb}`, { toolCallId: e.proposal.toolCallId, hunkId: e.hunkId, path: e.proposal.path });
          break;
        case "answered":
          if (local) break; // no tool card mirrors a local proposal
          if (e.answer.outcome === "selected") dispatch({ type: "permission_resolved", toolCallId: e.proposal.toolCallId, optionId: e.answer.optionId });
          else dispatch({ type: "permission_cancelled", toolCallId: e.proposal.toolCallId });
          break;
        case "cancelled":
          if (quill) applyOps(quill, discardHunksOps(currentOps(quill), e.proposal.hunks.map((h) => h.id)));
          dispatch({ type: "permission_cancelled", toolCallId: e.proposal.toolCallId });
          break;
        case "write":
          // A fold-in decided with at least one Accept: the buffer is no longer a short prelim.
          if (local && e.proposal.local?.folded && Object.values(e.proposal.states).includes("accept")) {
            setShortPrelim(false);
            audit.record("short_prelim.folded", { toolCallId: e.proposal.toolCallId });
          }
          break;
      }
      if (quill) setUnreviewedCount(unreviewedLineCount(currentOps(quill)));
      refresh();
    });
  }, [proposals, audit, quill]);

  useEffect(() => audit.subscribe(() => setAuditRecords([...audit.records])), [audit]);
  useEffect(() => flags.subscribe(() => setFlagList(flags.list())), [flags]);

  // ---- flags (design 04 §3.5): the agent's second channel — a card in the sidebar, a mark on the line, never an edit
  const raiseFlag = useCallback(
    (p: FlagParams) => {
      const flag = flags.raise(p);
      const loc = p.locations[0];
      let found = false;
      if (quill && store && loc?.line) {
        const r = resolvePath(loc.path, fixture.session.accession);
        if (r && (r.kind === "report" || r.kind === "section")) {
          // The line number counts the text the agent actually read: the grant's base text while one is open.
          const served = proposals.peekGrant(loc.path)?.baseText ?? safe(() => store.read(loc.path));
          const text = served == null ? undefined : canonicalLines(served)[loc.line - 1];
          if (text !== undefined) {
            const res = flagLineOps(currentOps(quill), { section: r.kind === "section" ? r.id : null, ordinal: loc.line, text }, flag.id);
            if (res.found) applyOps(quill, res.ops);
            found = res.found;
          }
        }
      }
      audit.record("flag.raised", { flagId: flag.id, ...(loc ? { path: loc.path } : {}), outcome: found || !loc ? flag.kind : `${flag.kind} · line not found` });
    },
    [flags, quill, store, fixture, proposals, audit],
  );
  const acknowledgeFlag = useCallback(
    (id: string) => {
      if (!flags.acknowledge(id)) return;
      if (quill) applyOps(quill, clearFlagOps(currentOps(quill), id));
      audit.record("flag.acknowledged", { flagId: id });
    },
    [flags, quill, audit],
  );
  const locateFlag = useCallback(
    (id: string) => {
      if (!quill) return;
      const idx = flagLineIndex(currentOps(quill), id);
      if (idx < 0) return;
      quill.setSelection(idx, 0, "silent");
      quill.scrollSelectionIntoView();
    },
    [quill],
  );

  // Connect once the editor exists: the ReportStore serves fs/* from live Quill state.
  useEffect(() => {
    if (!quill || !store) return;
    let cancelled = false;
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
      onFlag: (p) => {
        if (cancelled) return; // this effect's own teardown (StrictMode's first mount)
        raiseFlag(p);
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
  }, [quill, store, fixture, proposals, audit, renderProposal, raiseFlag]);

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

  // ---- commands: one registry, three surfaces -------------------------------------------

  const commandContext = useCallback((): CommandContext => {
    const markdown = store?.reportMarkdown() ?? "\n";
    const caret = quill ? caretInfo(quill, caretRef.current) : { caretSection: null, caretAtEnd: false };
    return {
      blank: isBlankApartFromSlash(markdown),
      shortPrelim,
      caretSection: caret.caretSection,
      caretAtEnd: caret.caretAtEnd,
      hasPriors: Object.keys(fixture.priors).length > 0,
      level: header.status === "ready" ? header.level : undefined,
      skills: state.commands,
    };
  }, [store, quill, shortPrelim, fixture, header.status, header.level, state.commands]);
  const commands = useCallback((): CommandGroups => listCommands(commandContext()), [commandContext]);

  const runCommand = useCallback(
    (command: Command, arg?: string) => {
      setHint(null);
      if (command.kind === "skill") {
        const text = `/${command.id}${arg ? ` ${arg}` : ""}`;
        if (!agentPort) {
          setHint("the agent is not connected");
          return;
        }
        audit.record(`command.${command.id}`, { outcome: "skill" });
        dispatch({ type: "user", text });
        void agentPort.prompt(text);
        return;
      }
      if (!quill || !store) return;
      const effect = runEditorCommand(command.id, arg, {
        markdown: store.reportMarkdown(),
        meta: fixture.meta,
        region: fixture.session.region,
        shortPrelim,
        templates,
        snippets,
      });
      const result = applyEffect(effect, {
        quill,
        accession: fixture.session.accession,
        proposals,
        currentMarkdown: () => store.reportMarkdown(),
        renderProposal,
        commandId: command.id,
      });
      switch (result.outcome) {
        case "instant":
          audit.record(`command.${command.id}`, { outcome: "instant" });
          if (result.shortPrelim !== undefined) setShortPrelim(result.shortPrelim);
          if (result.folded) audit.record("short_prelim.folded");
          break;
        case "caret":
          audit.record(`command.${command.id}`, { outcome: "already present" });
          break;
        case "hint":
          setHint(result.text);
          break;
        case "proposal":
          break; // audited on the `proposed` event
      }
      setUnreviewedCount(unreviewedLineCount(currentOps(quill)));
    },
    [agentPort, audit, quill, store, fixture, shortPrelim, proposals, renderProposal],
  );

  const decide = useCallback((toolCallId: string, hunkId: string, verb: Verb) => proposals.decide(toolCallId, hunkId, verb), [proposals]);
  const pending = proposalList.filter((p) => p.state === "pending");
  const pendingHunks = pending.reduce((n, p) => n + p.hunks.filter((h) => p.states[h.id] === "pending").length, 0);
  const allLocal = pending.length > 0 && pending.every((p) => p.origin === "local");
  const openFlags = flagList.filter((f) => f.state === "open");

  return (
    <div className="grid h-full grid-cols-[minmax(0,1fr)_400px] grid-rows-[auto_minmax(0,1fr)]">
      <header className="col-span-2 flex items-center gap-3 border-b border-gray-200 px-4 py-2 text-sm">
        <span className="font-semibold">ACP-Rad</span>
        <span className="text-gray-500">{fixture.title}</span>
        <span className="text-xs text-gray-400">{fixture.session.accession}</span>
        {hint && (
          <span data-testid="hint" className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
            {hint}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2 text-xs">
          {pendingHunks > 0 && (
            <span className="flex items-center gap-2 rounded-full border border-emerald-500 bg-emerald-50 px-2 py-0.5">
              {pendingHunks} change{pendingHunks === 1 ? "" : "s"}
              <button type="button" className="font-medium underline" onClick={() => pending.forEach((p) => proposals.decideAll(p.toolCallId, allLocal ? "accept" : "accept_edit"))}>
                {allLocal ? "Accept all" : "Accept all for review"}
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
          {openFlags.length > 0 && (
            <span data-testid="flag-count" className="rounded-full border border-rose-400 bg-rose-50 px-2 py-0.5">
              {openFlags.length} flag{openFlags.length === 1 ? "" : "s"}
            </span>
          )}
          <span data-testid="status" className="rounded bg-amber-100 px-2 py-0.5 text-amber-800">
            {status}
            {shortPrelim ? " · short prelim" : ""}
          </span>
          <span className="text-gray-400">{fixture.session.phiBoundary}</span>
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
          overlay={(q, tick) => (
            <>
              <HunkControls quill={q} proposals={proposalList} tick={tick} onDecide={decide} />
              <SlashMenu quill={q} tick={tick} commands={commands} onRun={runCommand} />
              <CommandsButton commands={commands} onRun={runCommand} />
            </>
          )}
        />
      </main>
      <Sidebar
        state={state}
        dispatch={dispatch}
        header={header}
        agent={agentPort}
        audit={auditRecords}
        commands={commands}
        onCommand={runCommand}
        flags={openFlags}
        onAcknowledge={acknowledgeFlag}
        onLocate={locateFlag}
      />
    </div>
  );
}

/** Which section the caret is in (overlay lines skipped) and whether it sits on the last line. */
function caretInfo(quill: Quill, sel: Range | null): { caretSection: SectionId | null; caretAtEnd: boolean } {
  const lines = splitLines(currentOps(quill));
  if (!sel || lines.length === 0) return { caretSection: null, caretAtEnd: false };
  let idx = 0;
  let li = lines.length - 1;
  for (let i = 0; i < lines.length; i++) {
    const len = lineLength(lines[i]!);
    if (sel.index < idx + len) {
      li = i;
      break;
    }
    idx += len;
  }
  let caretSection: SectionId | null = null;
  for (let i = li; i >= 0; i--) {
    const line = lines[i]!;
    if (isInsertLine(line)) continue;
    const id = sectionIdOfLine(lineText(line));
    if (id) {
      caretSection = id;
      break;
    }
  }
  return { caretSection, caretAtEnd: li === lines.length - 1 };
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

