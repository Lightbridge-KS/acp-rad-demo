/**
 * Agent sidebar on assistant-ui (ADR 0001, partial adoption): external-store runtime +
 * unstyled primitives, styled with Tailwind. It MIRRORS decisions — the permission is
 * decided in the report — so no `onRespondToToolApproval` is supplied (load-bearing).
 *
 * Flags (design 04 §3.5) are the one decision the sidebar owns: open flags sit in a card strip
 * above the thread with an **Acknowledge** button; the report only carries the mark.
 *
 * The composer's `/` lists the agent's **skills only** (assistant-ui's trigger popover,
 * unstable API, pinned 0.15.17): the chat box is the agent's channel, so a deterministic
 * editor command never runs from it (KS, 2026-08-30 — those live in `Commands ▾` and the
 * in-report `/`). A skill is sent as `/name`; one with an argument hint is only typed in.
 */
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  unstable_useSlashCommandAdapter,
  useAui,
  useExternalStoreRuntime,
  type AppendMessage,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AuditRecord, FlagKind, ProfileLevel } from "acp-rad";
import { useMemo, useState, type Dispatch } from "react";
import { GROUP_LABEL, matchScore, type Command, type CommandGroups } from "../commands/registry.ts";
import type { Flag } from "../report/flags.ts";
import { convertMessage } from "./convert.ts";
import type { AcpMessage, SidebarAction, SidebarState } from "./store.ts";

export type AgentPort = {
  /** Sends one turn; resolves with its stop reason (`end_turn`, `cancelled`, …, or `error`) — the QA gate counts on it. */
  prompt: (text: string) => Promise<string>;
  cancel: () => Promise<void>;
  /** `session/set_config_option` — the model select; absent when the agent offers none. */
  setConfigOption?: (configId: string, value: string) => Promise<void>;
};

export type HeaderState = {
  status: "disconnected" | "connecting" | "ready" | "error";
  agentName?: string;
  level?: ProfileLevel;
  /** From `initialize` — informational; stale once the session's `model` option changes. */
  model?: string;
  /** The session's config options (ACP); the `model` select drives the header's model control. */
  configOptions?: SessionConfigOption[];
  error?: string;
};

type SelectChoice = { value: string; name: string };

/** The `model` select, flattened (deepagents-acp sends plain options; the schema also allows groups). */
export function modelSelect(options: SessionConfigOption[] | undefined): { current: string; choices: SelectChoice[] } | undefined {
  const o = options?.find((c) => c.id === "model");
  if (!o || o.type !== "select") return undefined;
  const choices = (o.options as Array<SelectChoice | { options: SelectChoice[] }>).flatMap((x) => ("value" in x ? [x] : x.options));
  return { current: o.currentValue, choices };
}

type Props = {
  state: SidebarState;
  dispatch: Dispatch<SidebarAction>;
  header: HeaderState;
  agent: AgentPort | null;
  audit: AuditRecord[];
  /** The command registry; the composer's `/` menu shows its Skills group only. */
  commands?: () => CommandGroups;
  /** Run an argument-less skill picked in the composer. */
  onCommand?: (command: Command) => void;
  /** Open flags, newest last. */
  flags?: Flag[];
  onAcknowledge?: (flagId: string) => void;
  /** Scroll the report to the flag's line. */
  onLocate?: (flagId: string) => void;
  /** Explicitly create a fresh ACP and agent session after a disconnect. */
  onReconnect?: () => void;
};

const STATUS_DOT: Record<HeaderState["status"], string> = {
  disconnected: "bg-gray-400",
  connecting: "bg-amber-400 animate-pulse",
  ready: "bg-emerald-500",
  error: "bg-red-500",
};

const EMPTY_GROUPS: CommandGroups = { suggested: [], editor: [], skills: [] };

export function Sidebar({ state, dispatch, header, agent, audit, commands, onCommand, flags = [], onAcknowledge, onLocate, onReconnect }: Props) {
  const runtime = useExternalStoreRuntime<AcpMessage>({
    messages: state.messages,
    isRunning: state.isRunning,
    convertMessage,
    onNew: async (m: AppendMessage) => {
      const text = m.content.map((p) => (p.type === "text" ? p.text : "")).join("");
      if (!agent || !text.trim() || state.isRunning) return; // one turn at a time
      dispatch({ type: "user", text });
      await agent.prompt(text);
    },
    onCancel: async () => {
      await agent?.cancel();
    },
    // Deliberately NO onRespondToToolApproval: the Quill tracked change owns accept/reject.
  });
  const [tab, setTab] = useState<"chat" | "audit">("chat");
  const canSend = header.status === "ready" && agent !== null;
  const model = modelSelect(header.configOptions);
  const last = state.messages[state.messages.length - 1];
  const stopped = last?.role === "assistant" && last.stopReason === "cancelled";

  return (
    <aside className="flex h-full flex-col border-l border-gray-200 bg-gray-50">
      <header className="flex items-center gap-2 border-b border-gray-200 px-3 py-2 text-sm">
        <span className={`inline-block h-2.5 w-2.5 rounded-full ${STATUS_DOT[header.status]}`} />
        <span className="font-medium">{header.agentName ?? "agent"}</span>
        {header.level !== undefined && <span className="rounded bg-gray-200 px-1.5 py-0.5 text-xs">L{header.level}</span>}
        {model && agent?.setConfigOption ? (
          // Switching mid-turn would swap the agent under the running prompt — wait for the turn.
          <select
            data-testid="model-select"
            className="max-w-48 truncate rounded border border-gray-300 bg-white px-1 py-0.5 text-xs text-gray-700"
            value={model.current}
            disabled={state.isRunning}
            onChange={(e) => void agent.setConfigOption!("model", e.target.value)}
          >
            {model.choices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.name}
              </option>
            ))}
          </select>
        ) : (
          (model?.current ?? header.model) && <span className="text-xs text-gray-500">· {model?.current ?? header.model}</span>
        )}
        <span className="ml-auto text-xs text-gray-500">{state.isRunning ? "working…" : header.status}</span>
        {(header.status === "disconnected" || header.status === "error") && onReconnect && (
          <button
            type="button"
            data-testid="reconnect-agent"
            className="rounded border border-gray-300 bg-white px-2 py-0.5 text-xs font-medium text-gray-700"
            onClick={onReconnect}
          >
            Reconnect agent
          </button>
        )}
      </header>
      <nav className="flex gap-1 border-b border-gray-200 px-2 text-xs">
        {(["chat", "audit"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`px-2 py-1 ${tab === t ? "border-b-2 border-sky-600 font-medium" : "text-gray-500"}`}
          >
            {t === "chat" ? "Chat" : `Audit · ${audit.length}`}
          </button>
        ))}
      </nav>

      {tab === "audit" ? (
        <AuditPanel records={audit} />
      ) : (
        <AssistantRuntimeProvider runtime={runtime}>
          <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
            {flags.length > 0 && <FlagCards flags={flags} onAcknowledge={onAcknowledge} onLocate={onLocate} />}
            <ThreadPrimitive.Viewport className="flex-1 space-y-2 overflow-y-auto px-3 py-3 text-sm">
              <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
              {stopped && (
                <p data-testid="stopped" className="text-xs text-gray-500 italic">
                  stopped
                </p>
              )}
              {header.error && <p className="text-red-600">{header.error}</p>}
            </ThreadPrimitive.Viewport>
            <Composer canSend={canSend} commands={commands} onCommand={onCommand} />
          </ThreadPrimitive.Root>
        </AssistantRuntimeProvider>
      )}
    </aside>
  );
}

function Composer({ canSend, commands, onCommand }: { canSend: boolean; commands?: () => CommandGroups; onCommand?: (c: Command) => void }) {
  const aui = useAui();
  const groups = commands?.() ?? EMPTY_GROUPS;
  // Skills only: editor commands are not chat (design 02 §2.2).
  const entries = useMemo(() => groups.skills.map((c) => ({ id: c.id, command: c })), [groups]);
  const slash = unstable_useSlashCommandAdapter({
    removeOnExecute: true,
    commands: entries.map(({ id, command: c }) => ({
      id,
      label: `/${c.id}`,
      description: c.description,
      execute: () => {
        // A skill with an argument is only typed in; the radiologist completes and sends it.
        if (c.kind === "skill" && c.hint) aui.composer.setText(`/${c.id} `);
        else onCommand?.(c);
      },
    })),
  });
  // assistant-ui's search matches descriptions too; rank by id first so a skill named in the
  // query always comes before one that merely mentions it.
  const adapter = useMemo(
    () => ({
      ...slash.adapter,
      search: (query: string) => {
        const base = slash.adapter.search?.(query) ?? [];
        if (!query.trim()) return base;
        const seen = new Set<string>();
        return base
          .map((item, order) => ({ item, order, score: matchScore(entries.find((e) => e.id === item.id)!.command, query) }))
          .filter(({ item, score }) => score >= 0 && !seen.has(item.label) && seen.add(item.label))
          .sort((a, b) => a.score - b.score || a.order - b.order)
          .map(({ item }) => item);
      },
    }),
    [slash.adapter, entries],
  );
  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <ComposerPrimitive.Root className="relative border-t border-gray-200 p-2">
        <ComposerPrimitive.Unstable_TriggerPopover
          char="/"
          adapter={adapter}
          data-testid="composer-slash"
          className="absolute right-2 bottom-full left-2 z-30 mb-1 max-h-72 overflow-y-auto rounded-md border border-gray-200 bg-white py-1 text-sm shadow-lg"
        >
          <ComposerPrimitive.Unstable_TriggerPopover.Action {...slash.action} />
          <ComposerPrimitive.Unstable_TriggerPopoverItems>
            {(items) => {
              return items.map((item, index) => {
                return (
                  <div key={item.id}>
                    {index === 0 && <div className="px-3 pt-1.5 pb-0.5 text-[10px] font-semibold tracking-wide text-gray-400 uppercase">{GROUP_LABEL.skills}</div>}
                    <ComposerPrimitive.Unstable_TriggerPopoverItem
                      item={item}
                      index={index}
                      className="flex w-full items-baseline gap-2 px-3 py-1 text-left hover:bg-gray-50 data-[highlighted]:bg-sky-50"
                    >
                      <span className="font-mono text-xs whitespace-nowrap">{item.label}</span>
                      <span className="ml-auto min-w-0 truncate text-xs text-gray-500">{item.description}</span>
                    </ComposerPrimitive.Unstable_TriggerPopoverItem>
                  </div>
                );
              });
            }}
          </ComposerPrimitive.Unstable_TriggerPopoverItems>
        </ComposerPrimitive.Unstable_TriggerPopover>
        <ComposerPrimitive.Input
          className="h-20 w-full resize-none rounded border border-gray-300 p-2 text-sm"
          placeholder="Ask the agent… (/ opens the commands · Enter to send, Shift+Enter for newline)"
          disabled={!canSend}
        />
        <div className="mt-1 flex justify-end gap-2">
          <ThreadPrimitive.If running>
            <ComposerPrimitive.Cancel className="rounded bg-red-600 px-3 py-1 text-sm text-white">Stop</ComposerPrimitive.Cancel>
          </ThreadPrimitive.If>
          <ThreadPrimitive.If running={false}>
            <ComposerPrimitive.Send disabled={!canSend} className="rounded bg-sky-600 px-3 py-1 text-sm text-white disabled:opacity-40">
              Send
            </ComposerPrimitive.Send>
          </ThreadPrimitive.If>
        </div>
      </ComposerPrimitive.Root>
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  );
}

const UserMessage = () => (
  <MessagePrimitive.Root className="ml-6 rounded-lg bg-sky-100 px-3 py-2 whitespace-pre-wrap">
    <MessagePrimitive.Parts />
  </MessagePrimitive.Root>
);

const AssistantMessage = () => (
  <MessagePrimitive.Root className="mr-2 space-y-1">
    <MessagePrimitive.Parts components={{ Text, Reasoning, tools: { Fallback: ToolCard } }} />
  </MessagePrimitive.Root>
);

const Text = ({ text }: { text: string }) => (
  <div className="rounded-lg bg-white px-3 py-2 whitespace-pre-wrap shadow-sm">{text}</div>
);

const Reasoning = ({ text }: { text: string }) => (
  <details className="rounded-lg bg-gray-100 px-3 py-1 text-xs text-gray-600">
    <summary className="cursor-pointer">thinking…</summary>
    <p className="whitespace-pre-wrap pt-1">{text}</p>
  </details>
);

const KIND_LABEL: Record<string, string> = { read: "read", edit: "edit", search: "search", execute: "run", think: "think", fetch: "fetch" };

const FLAG_KIND_STYLE: Record<FlagKind, string> = {
  discrepancy: "border-rose-300 bg-rose-100 text-rose-800",
  omission: "border-amber-300 bg-amber-100 text-amber-800",
  unsupported: "border-violet-300 bg-violet-100 text-violet-800",
  critical_uncommunicated: "border-red-400 bg-red-100 text-red-800",
};

/** Open flags: kind · summary · where; Acknowledge is the sidebar's one decision. */
function FlagCards({ flags, onAcknowledge, onLocate }: { flags: Flag[]; onAcknowledge?: (id: string) => void; onLocate?: (id: string) => void }) {
  return (
    <div data-testid="flags" className="max-h-56 space-y-1.5 overflow-y-auto border-b border-rose-200 bg-rose-50/60 px-3 py-2 text-sm">
      {flags.map((f) => {
        const loc = f.locations[0];
        return (
          <div key={f.id} data-testid="flag" data-kind={f.kind} className="rounded border border-rose-200 bg-white px-2 py-1.5 shadow-sm">
            <button type="button" className="w-full text-left" onClick={() => onLocate?.(f.id)} title="Show in the report">
              <span className={`mr-2 rounded border px-1.5 py-0.5 font-mono text-[11px] ${FLAG_KIND_STYLE[f.kind]}`}>{f.kind.replaceAll("_", " ")}</span>
              {loc && (
                <span className="font-mono text-[11px] text-gray-500">
                  {loc.path.replace(/^\/worklist\/[^/]+\//, "")}
                  {loc.line !== undefined ? ` · line ${loc.line}` : ""}
                </span>
              )}
              <p className="mt-1 text-gray-800">{f.summary}</p>
            </button>
            <div className="mt-1 flex justify-end">
              <button
                type="button"
                data-testid="acknowledge"
                onClick={() => onAcknowledge?.(f.id)}
                className="rounded-full border border-gray-300 px-2 py-0.5 text-xs hover:bg-gray-100"
              >
                Acknowledge
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Mirrors the decision made in the report; never offers one. */
const ToolCard = ({ toolName, args, status, approval, artifact }: ToolCallMessagePartProps) => {
  const diff = artifact as { path?: string } | undefined;
  const title = String((args as { title?: string }).title ?? "");
  // deepagents-acp gives non-fs tools kind `other` and the bare tool name as title.
  const label = title === "raise_flag" ? "flag" : (KIND_LABEL[toolName] ?? toolName);
  const decision = approval && (approval.approved === undefined ? "awaiting your decision in the report" : decisionLabel(approval.optionId, approval.approved));
  return (
    <div
      data-testid="tool"
      data-status={status.type}
      className={`flex flex-wrap items-center gap-2 rounded border px-2 py-1 font-mono text-xs ${
        status.type === "requires-action" ? "border-emerald-500 bg-emerald-50" : "border-gray-200 bg-white"
      }`}
    >
      <span className="rounded bg-gray-100 px-1">{label}</span>
      <span className="truncate" title={title}>
        {title}
      </span>
      {diff?.path && <code className="text-gray-500">{diff.path.replace(/^\/worklist\/[^/]+\//, "")}</code>}
      <span className={`ml-auto ${status.type === "complete" ? "text-emerald-600" : status.type === "incomplete" ? "text-red-600" : "text-gray-400"}`}>
        {status.type}
      </span>
      {decision && (
        <span data-testid="decision" className="basis-full text-gray-600">
          {decision}
        </span>
      )}
    </div>
  );
};

/** The clinical verb as the radiologist said it; a Level 0 option id is shown as-is. */
function decisionLabel(optionId: string | undefined, approved: boolean): string {
  switch (optionId) {
    case "accept":
      return "accepted";
    case "accept_edit":
      return "accepted for review";
    case "reject":
      return "rejected";
    default:
      return `${approved ? "accepted" : "rejected"} (${optionId ?? "?"})`;
  }
}

/** Event families for the audit filter — the prefix before the first `.` (`fs.read` → `fs`). */
const AUDIT_FAMILIES = ["fs", "permission", "proposal", "hunk", "flag", "qa", "status", "command", "session", "review"] as const;
const familyOf = (event: string): string => event.split(".")[0] ?? event;

function AuditPanel({ records }: { records: AuditRecord[] }) {
  const [family, setFamily] = useState<string>("all");
  const rows = useMemo(() => [...records].reverse().filter((r) => family === "all" || familyOf(r.event) === family), [records, family]);
  const present = useMemo(() => new Set(records.map((r) => familyOf(r.event))), [records]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div data-testid="audit-filter" className="flex flex-wrap gap-1 border-b border-gray-200 px-2 py-1 text-[11px]">
        {["all", ...AUDIT_FAMILIES.filter((f) => present.has(f))].map((f) => (
          <button key={f} type="button" data-active={family === f} className={`rounded px-1.5 py-0.5 ${family === f ? "bg-gray-800 text-white" : "bg-gray-200 text-gray-700"}`} onClick={() => setFamily(f)}>
            {f}
          </button>
        ))}
      </div>
      <ol className="flex-1 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-5">
        {rows.length === 0 && <li className="text-gray-400">no events yet</li>}
        {rows.map((r, i) => (
          <li key={`${r.ts}-${i}`} className="border-b border-dotted border-gray-300">
            <span className="text-gray-400">{r.ts.slice(11, 19)}</span> <span className="text-gray-400">{r.actor.role}</span> <span className="font-medium">{r.event}</span>
            {r.path && <span className="text-gray-500"> {r.path.replace(/^\/worklist\/[^/]+\//, "")}</span>}
            {r.hunkId && <span className="text-gray-500"> {r.hunkId}</span>}
            {r.flagId && <span className="text-gray-500"> {r.flagId}</span>}
            {r.flagIds && r.flagIds.length > 0 && <span className="text-gray-500"> {r.flagIds.join(" ")}</span>}
            {r.outcome && <span className="text-gray-500"> → {r.outcome}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}
