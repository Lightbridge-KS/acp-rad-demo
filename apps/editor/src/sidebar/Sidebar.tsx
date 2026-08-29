/**
 * Agent sidebar on assistant-ui (ADR 0001, partial adoption): external-store runtime +
 * unstyled primitives, styled with Tailwind. It MIRRORS decisions — the permission is
 * decided in the report — so no `onRespondToToolApproval` is supplied (load-bearing).
 *
 * The composer's `/` opens the same command registry as the editor (assistant-ui's trigger
 * popover, unstable API, pinned 0.15.17): editor commands run through `onCommand`, skills are
 * sent as `/name`; a skill with an argument hint is only typed into the composer.
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
import type { AuditRecord, ProfileLevel } from "acp-rad";
import { useMemo, useState, type Dispatch } from "react";
import { GROUP_LABEL, flattenCommands, type Command, type CommandGroups } from "../commands/registry.ts";
import { convertMessage } from "./convert.ts";
import type { AcpMessage, SidebarAction, SidebarState } from "./store.ts";

export type AgentPort = {
  prompt: (text: string) => Promise<void>;
  cancel: () => Promise<void>;
};

export type HeaderState = {
  status: "disconnected" | "connecting" | "ready" | "error";
  agentName?: string;
  level?: ProfileLevel;
  model?: string;
  error?: string;
};

type Props = {
  state: SidebarState;
  dispatch: Dispatch<SidebarAction>;
  header: HeaderState;
  agent: AgentPort | null;
  audit: AuditRecord[];
  /** The command registry for the composer's `/` menu. */
  commands?: () => CommandGroups;
  /** Run a command picked in the composer (editor commands and argument-less skills). */
  onCommand?: (command: Command) => void;
};

const STATUS_DOT: Record<HeaderState["status"], string> = {
  disconnected: "bg-gray-400",
  connecting: "bg-amber-400 animate-pulse",
  ready: "bg-emerald-500",
  error: "bg-red-500",
};

const EMPTY_GROUPS: CommandGroups = { suggested: [], editor: [], skills: [] };

export function Sidebar({ state, dispatch, header, agent, audit, commands, onCommand }: Props) {
  const runtime = useExternalStoreRuntime<AcpMessage>({
    messages: state.messages,
    isRunning: state.isRunning,
    convertMessage,
    onNew: async (m: AppendMessage) => {
      const text = m.content.map((p) => (p.type === "text" ? p.text : "")).join("");
      if (!agent || !text.trim()) return;
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
  const last = state.messages[state.messages.length - 1];
  const stopped = last?.role === "assistant" && last.stopReason === "cancelled";

  return (
    <aside className="flex h-full flex-col border-l border-gray-200 bg-gray-50">
      <header className="flex items-center gap-2 border-b border-gray-200 px-3 py-2 text-sm">
        <span className={`inline-block h-2.5 w-2.5 rounded-full ${STATUS_DOT[header.status]}`} />
        <span className="font-medium">{header.agentName ?? "agent"}</span>
        {header.level !== undefined && <span className="rounded bg-gray-200 px-1.5 py-0.5 text-xs">L{header.level}</span>}
        {header.model && <span className="text-xs text-gray-500">· {header.model}</span>}
        <span className="ml-auto text-xs text-gray-500">{state.isRunning ? "working…" : header.status}</span>
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
  const flat = flattenCommands(groups);
  const groupOf = useMemo(() => {
    const m = new Map<string, keyof CommandGroups>();
    for (const g of ["skills", "editor", "suggested"] as const) for (const c of groups[g]) m.set(c.id, g);
    return m;
  }, [groups]);
  const slash = unstable_useSlashCommandAdapter({
    removeOnExecute: true,
    commands: flat.map((c) => ({
      id: c.id,
      label: `/${c.id}`,
      description: c.description,
      execute: () => {
        // A skill with an argument is only typed in; the radiologist completes and sends it.
        if (c.kind === "skill" && c.hint) aui.composer.setText(`/${c.id} `);
        else onCommand?.(c);
      },
    })),
  });
  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <ComposerPrimitive.Root className="relative border-t border-gray-200 p-2">
        <ComposerPrimitive.Unstable_TriggerPopover
          char="/"
          adapter={slash.adapter}
          data-testid="composer-slash"
          className="absolute right-2 bottom-full left-2 z-30 mb-1 max-h-72 overflow-y-auto rounded-md border border-gray-200 bg-white py-1 text-sm shadow-lg"
        >
          <ComposerPrimitive.Unstable_TriggerPopover.Action {...slash.action} />
          <ComposerPrimitive.Unstable_TriggerPopoverItems>
            {(items) => {
              let lastGroup: string | undefined;
              return items.map((item, index) => {
                const g = groupOf.get(item.id);
                const header = g && g !== lastGroup ? GROUP_LABEL[g] : null;
                lastGroup = g ?? lastGroup;
                return (
                  <div key={item.id}>
                    {header && <div className="px-3 pt-1.5 pb-0.5 text-[10px] font-semibold tracking-wide text-gray-400 uppercase">{header}</div>}
                    <ComposerPrimitive.Unstable_TriggerPopoverItem
                      item={item}
                      index={index}
                      className="flex w-full items-baseline gap-2 px-3 py-1 text-left hover:bg-gray-50 data-[highlighted]:bg-sky-50"
                    >
                      <span className="font-mono text-xs">{item.label}</span>
                      <span className="ml-auto truncate text-xs text-gray-500">{item.description}</span>
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

/** Mirrors the decision made in the report; never offers one. */
const ToolCard = ({ toolName, args, status, approval, artifact }: ToolCallMessagePartProps) => {
  const diff = artifact as { path?: string } | undefined;
  const title = String((args as { title?: string }).title ?? "");
  const decision = approval && (approval.approved === undefined ? "awaiting your decision in the report" : decisionLabel(approval.optionId, approval.approved));
  return (
    <div
      data-testid="tool"
      data-status={status.type}
      className={`flex flex-wrap items-center gap-2 rounded border px-2 py-1 font-mono text-xs ${
        status.type === "requires-action" ? "border-emerald-500 bg-emerald-50" : "border-gray-200 bg-white"
      }`}
    >
      <span className="rounded bg-gray-100 px-1">{KIND_LABEL[toolName] ?? toolName}</span>
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

function AuditPanel({ records }: { records: AuditRecord[] }) {
  const rows = useMemo(() => [...records].reverse(), [records]);
  return (
    <ol className="flex-1 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-5">
      {rows.length === 0 && <li className="text-gray-400">no events yet</li>}
      {rows.map((r, i) => (
        <li key={`${r.ts}-${i}`} className="border-b border-dotted border-gray-300">
          <span className="text-gray-400">{r.ts.slice(11, 19)}</span> <span className="font-medium">{r.event}</span>
          {r.path && <span className="text-gray-500"> {r.path.replace(/^\/worklist\/[^/]+\//, "")}</span>}
          {r.hunkId && <span className="text-gray-500"> {r.hunkId}</span>}
          {r.outcome && <span className="text-gray-500"> → {r.outcome}</span>}
        </li>
      ))}
    </ol>
  );
}
