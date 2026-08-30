/**
 * `Commands ▾` — the full registry behind one button in the editor's toolbar row.
 * Mouse or keyboard (↑↓⏎⎋ while open); closes on outside click.
 */
import { useEffect, useRef, useState } from "react";
import { CommandMenu, menuKey } from "./CommandMenu.tsx";
import { flattenCommands, type Command, type CommandGroups } from "./registry.ts";

type Props = {
  commands: () => CommandGroups;
  onRun: (command: Command) => void;
};

export function CommandsButton({ commands, onRun }: Props) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const groups = open ? commands() : null;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const run = (c: Command) => {
    setOpen(false);
    onRun(c);
  };

  return (
    <div ref={rootRef} className="pointer-events-auto absolute top-1.5 left-40 z-20 text-sm">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid="commands-button"
        onClick={() => {
          setOpen((o) => !o);
          setHighlighted(0);
        }}
        onKeyDown={(e) => {
          if (!open || !groups) return;
          const action = menuKey(e.key, highlighted, flattenCommands(groups).length);
          if (!action) return;
          e.preventDefault();
          if (action.type === "move") setHighlighted(action.index);
          else if (action.type === "select") {
            const c = flattenCommands(groups)[action.index];
            if (c) run(c);
          } else setOpen(false);
        }}
        className="rounded border border-gray-300 bg-white px-2 py-0.5 text-xs shadow-sm hover:bg-gray-50"
      >
        ⌘ Commands ▾
      </button>
      {open && groups && (
        <div className="absolute left-0 mt-1 w-[28rem] rounded-md border border-gray-200 bg-white shadow-lg">
          <CommandMenu groups={groups} highlighted={highlighted} onHighlight={setHighlighted} onSelect={run} />
        </div>
      )}
    </div>
  );
}
