/**
 * The in-report `/` menu (Notion-style) over Quill 2.
 *
 * Armed when the radiologist types `/` at a line start or after whitespace; `slashAt` then
 * derives the query from the caret on every editor change, reading one line only, and closes
 * the moment the caret leaves the query. The caret is tracked from `selection-change` events
 * (transformed by each text-change delta) — never via `quill.getSelection()`, which runs
 * `quill.update()` and can emit a text-change of its own, looping with React. While open, ↑↓⏎⇥⎋ are taken on the editor container
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
export type Range = { index: number; length: number };

/** The subset of Quill `slashAt` needs — small enough to fake in tests. Read-only calls only. */
export type SlashQuill = {
  getLine: (index: number) => [unknown, number];
  getText: (index: number, length: number) => string;
};

/** Where the `/` typed at `armedAt` now stands relative to the caret `sel`, or `null` if the menu must close. */
export function slashAt(q: SlashQuill, armedAt: number, sel: Range | null): SlashState | null {
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

/** Where the caret sits right after a user's own change: after its last insert, or at its delete. */
export function caretAfter(change: Op[]): Range | null {
  let pos = 0;
  let caret: number | null = null;
  for (const op of change) {
    if (op.retain !== undefined) pos += typeof op.retain === "number" ? op.retain : 1;
    else if (op.insert !== undefined) {
      pos += typeof op.insert === "string" ? op.insert.length : 1;
      caret = pos;
    } else if (op.delete !== undefined) caret = pos;
  }
  return caret === null ? null : { index: caret, length: 0 };
}

/** Move a caret through a change delta (inserts before it push it right, deletes pull it left). */
export function transformRange(sel: Range | null, change: Op[]): Range | null {
  if (!sel) return null;
  let pos = 0;
  let index = sel.index;
  for (const op of change) {
    if (pos > index) break;
    if (op.retain !== undefined) pos += typeof op.retain === "number" ? op.retain : 1;
    else if (op.insert !== undefined) {
      const n = typeof op.insert === "string" ? op.insert.length : 1;
      if (pos <= index) index += n;
      pos += n;
    } else if (op.delete !== undefined) {
      index = Math.max(pos, index - op.delete);
    }
  }
  return { index, length: 0 };
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
  const selRef = useRef<Range | null>(null);
  const armedRef = useRef<number | null>(null);
  armedRef.current = armedAt;

  // Track the caret from events; arm on a typed "/" (position taken from the change itself).
  useEffect(() => {
    const derive = () => {
      const at = armedRef.current;
      if (at === null) return;
      const sel = selRef.current;
      if (sel && sel.index > quill.getLength() - 1) return; // caret ahead of a model that is still updating
      const next = slashAt(quill, at, sel);
      setState(next);
      if (!next) setArmedAt(null);
    };
    const onText = (change: Delta, _old: Delta, source: string) => {
      // A user change carries its own caret (Quill's selection-change already reported it and
      // must not be transformed twice); an api change moves whatever caret we had.
      selRef.current = source === "user" ? (caretAfter(change.ops) ?? selRef.current) : transformRange(selRef.current, change.ops);
      if (source === "user") {
        const at = insertedSlashAt(change.ops);
        if (at >= 0) {
          selRef.current = { index: at + 1, length: 0 };
          armedRef.current = at;
          setArmedAt(at);
          setHighlighted(0);
        }
      }
      derive();
    };
    // Quill reports the caret before the model catches up with a keystroke; derive after the
    // text-change has landed (the text-change handler itself derives synchronously).
    const onSelection = (range: Range | null) => {
      if (range) selRef.current = range;
      setTimeout(derive, 0);
    };
    quill.on("text-change", onText);
    quill.on("selection-change", onSelection);
    return () => {
      quill.off("text-change", onText);
      quill.off("selection-change", onSelection);
    };
  }, [quill]);

  useEffect(() => {
    if (armedAt === null) setState(null);
  }, [armedAt]);

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

  void tick; // re-render on every text-change so the bounds follow the text
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
