/**
 * The in-report `/` menu (Notion-style) over Quill 2.
 *
 * Armed when the radiologist types `/` at a line start or after whitespace; `slashAt` then
 * derives the query from the caret on every editor change, reading one line only, and closes
 * the moment the caret leaves the query. While open, ↑↓⏎⇥⎋ are taken on the editor container
 * in the capture phase — Quill's keyboard module bails on `defaultPrevented`, so a plain
 * `preventDefault()` is all it takes. Selecting removes the `/query` text as a `user` edit
 * (⌘Z restores it) and runs the command.
 */
import type Quill from "quill";
import type { Delta, Op } from "quill";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CommandMenu, menuKey } from "./CommandMenu.tsx";
import { filterCommands, flattenCommands, parseInvocation, type Command, type CommandGroups } from "./registry.ts";

export type SlashState = { offset: number; query: string };

/** The subset of Quill `slashAt` needs — small enough to fake in tests. */
export type SlashQuill = {
  getSelection: () => { index: number; length: number } | null;
  getLine: (index: number) => [unknown, number];
  getText: (index: number, length: number) => string;
};

/** Where the `/` typed at `armedAt` now stands relative to the caret, or `null` if the menu must close. */
export function slashAt(q: SlashQuill, armedAt: number): SlashState | null {
  const sel = q.getSelection();
  if (!sel || sel.length !== 0) return null;
  const [, offset] = q.getLine(sel.index);
  const lineStart = sel.index - offset;
  const upTo = q.getText(lineStart, offset);
  const i = upTo.lastIndexOf("/");
  if (i < 0 || lineStart + i !== armedAt) return null;
  if (i > 0 && !/\s/.test(upTo[i - 1]!)) return null; // `2/5`, `dd/mm` never open the menu
  return { offset: armedAt, query: upTo.slice(i + 1) };
}

/** Character index of a `/` a user change inserted, or −1. */
export function insertedSlashAt(change: Op[]): number {
  let pos = 0;
  for (const op of change) {
    if (op.retain !== undefined) pos += typeof op.retain === "number" ? op.retain : 1;
    else if (typeof op.insert === "string") {
      const i = op.insert.indexOf("/");
      if (i >= 0) return pos + i;
      pos += op.insert.length;
    } else if (op.insert !== undefined) pos += 1;
  }
  return -1;
}

/** `name arg` narrows to the exact command; a bare name filters as usual. */
export function groupsForQuery(all: CommandGroups, query: string): { groups: CommandGroups; arg: string | undefined } {
  const { name, arg } = parseInvocation(query);
  if (!arg) return { groups: filterCommands(all, name), arg: undefined };
  const exact = (cs: Command[]) => cs.filter((c) => c.id === name);
  return { groups: { suggested: exact(all.suggested), editor: exact(all.editor), skills: exact(all.skills) }, arg };
}

type Props = {
  quill: Quill;
  /** Bumped by `ReportEditor` on every text-change. */
  tick: number;
  /** The registry as it stands now (context-aware). */
  commands: () => CommandGroups;
  onRun: (command: Command, arg: string | undefined) => void;
};

const MENU_HEIGHT = 288; // max-h-72

export function SlashMenu({ quill, tick, commands, onRun }: Props) {
  const [armedAt, setArmedAt] = useState<number | null>(null);
  const [state, setState] = useState<SlashState | null>(null);
  const [highlighted, setHighlighted] = useState(0);

  // Arm on a typed "/" (position taken from the change itself, not from the selection).
  useEffect(() => {
    const onText = (change: Delta, _old: Delta, source: string) => {
      if (source !== "user") return;
      const at = insertedSlashAt(change.ops);
      if (at >= 0) {
        setArmedAt(at);
        setHighlighted(0);
      }
    };
    quill.on("text-change", onText);
    return () => {
      quill.off("text-change", onText);
    };
  }, [quill]);

  // Re-derive on every editor change (text or selection) while armed.
  useEffect(() => {
    if (armedAt === null) {
      setState(null);
      return;
    }
    const derive = () => {
      const next = slashAt(quill, armedAt);
      setState(next);
      if (!next) setArmedAt(null);
    };
    derive();
    quill.on("editor-change", derive);
    return () => {
      quill.off("editor-change", derive);
    };
  }, [quill, armedAt, tick]);

  const resolved = useMemo(() => (state ? groupsForQuery(commands(), state.query) : null), [state, commands]);
  const flat = useMemo(() => (resolved ? flattenCommands(resolved.groups) : []), [resolved]);
  useEffect(() => {
    if (highlighted >= flat.length) setHighlighted(0);
  }, [flat.length, highlighted]);

  const close = useCallback(() => setArmedAt(null), []);
  const select = useCallback(
    (command: Command) => {
      if (!state) return;
      const arg = resolved?.arg;
      setArmedAt(null);
      quill.deleteText(state.offset, 1 + state.query.length, "user");
      onRun(command, arg);
    },
    [state, resolved, quill, onRun],
  );

  const highlightedRef = useRef(highlighted);
  highlightedRef.current = highlighted;
  const flatRef = useRef(flat);
  flatRef.current = flat;
  useEffect(() => {
    if (!state) return;
    const el = quill.container.parentElement ?? quill.root;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      const action = menuKey(e.key, highlightedRef.current, flatRef.current.length);
      if (!action) return;
      e.preventDefault();
      if (action.type === "move") setHighlighted(action.index);
      else if (action.type === "select") {
        const c = flatRef.current[action.index];
        if (c) select(c);
      } else close();
    };
    el.addEventListener("keydown", onKey, true);
    return () => el.removeEventListener("keydown", onKey, true);
  }, [state, quill, select, close]);

  if (!state || !resolved) return null;
  const bounds = quill.getBounds(state.offset, 0);
  if (!bounds) return null;
  const containerTop = quill.container.offsetTop;
  const above = bounds.bottom + MENU_HEIGHT > quill.container.clientHeight;
  return (
    <div
      data-testid="slash-menu"
      className="pointer-events-auto absolute z-20 w-[28rem] max-w-[calc(100%-2rem)] rounded-md border border-gray-200 bg-white shadow-lg"
      style={{
        left: Math.max(16, Math.min(bounds.left + quill.container.offsetLeft, quill.container.clientWidth - 460)),
        top: (above ? bounds.top : bounds.bottom) + containerTop,
        transform: above ? "translateY(-100%)" : undefined,
      }}
    >
      <CommandMenu groups={resolved.groups} highlighted={highlighted} onHighlight={setHighlighted} onSelect={select} />
    </div>
  );
}
