import type Quill from "quill";
import { useEffect, useState } from "react";
import type { Proposal, Verb } from "./proposals.ts";
import { currentOps } from "./overlayQuill.ts";
import { hunkLineIndex } from "./overlay.ts";

type Props = {
  quill: Quill;
  proposals: Proposal[];
  /** Bumped by the editor on every text-change so pill positions follow the text. */
  tick: number;
  onDecide: (toolCallId: string, hunkId: string, verb: Verb) => void;
};

type Pill = { toolCallId: string; hunkId: string; label: string; top: number; conflict: boolean };

/** Floating per-hunk verbs, anchored to the first line of each pending hunk (design §5.7). */
export function HunkControls({ quill, proposals, tick, onDecide }: Props) {
  const [pills, setPills] = useState<Pill[]>([]);

  useEffect(() => {
    const ops = currentOps(quill);
    const next: Pill[] = [];
    for (const p of proposals) {
      if (p.state !== "pending") continue;
      p.hunks.forEach((h, i) => {
        const state = p.states[h.id];
        if (state !== "pending" && state !== "conflict") return;
        const index = hunkLineIndex(ops, h.id);
        if (index < 0) return;
        const bounds = quill.getBounds(index, 0);
        if (!bounds) return;
        next.push({
          toolCallId: p.toolCallId,
          hunkId: h.id,
          label: `hunk ${i + 1}/${p.hunks.length}${p.section ? ` · ${p.section}` : ""}`,
          top: bounds.top,
          conflict: state === "conflict",
        });
      });
    }
    setPills(next);
  }, [quill, proposals, tick]);

  return (
    <>
      {pills.map((pill) => (
        <div
          key={`${pill.toolCallId}:${pill.hunkId}`}
          className="pointer-events-auto absolute right-3 z-10 flex items-center gap-1.5 rounded-full border border-gray-300 bg-white px-2 py-0.5 text-xs shadow-sm"
          style={{ top: Math.max(0, pill.top - 28) }}
        >
          <span className="text-gray-500">{pill.label}</span>
          {pill.conflict ? (
            <>
              <span className="text-red-600">conflict — re-propose</span>
              <Btn onClick={() => onDecide(pill.toolCallId, pill.hunkId, "reject")}>Dismiss</Btn>
            </>
          ) : (
            <>
              <Btn onClick={() => onDecide(pill.toolCallId, pill.hunkId, "accept")}>Insert</Btn>
              <Btn tone="draft" onClick={() => onDecide(pill.toolCallId, pill.hunkId, "accept_edit")}>
                Insert as draft
              </Btn>
              <Btn onClick={() => onDecide(pill.toolCallId, pill.hunkId, "reject")}>Discard</Btn>
            </>
          )}
        </div>
      ))}
    </>
  );
}

function Btn({ tone, onClick, children }: { tone?: "draft"; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2 py-0.5 hover:bg-gray-100 ${tone === "draft" ? "border-amber-400 bg-amber-50" : "border-gray-300"}`}
    >
      {children}
    </button>
  );
}
