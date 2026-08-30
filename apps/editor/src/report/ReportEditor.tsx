import Quill, { type Delta } from "quill";
import type { Op } from "quill";
import "quill/dist/quill.snow.css";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { OVERLAY_FORMATS, registerReportBlots } from "./blots.ts";
import { afterUserChange } from "./overlayQuill.ts";

/**
 * Formats a report may contain. Anything else (pasted or programmatic) is stripped by
 * Quill — the report document model is a whitelist. Mirrors the canonical grammar (bold,
 * italic, lists) plus the proposal overlay and unreviewed marks.
 */
const REPORT_FORMATS = ["bold", "italic", "list", ...OVERLAY_FORMATS];

type Props = {
  /** Canonical report as Delta ops (`markdownToDelta(reportMarkdown)`). */
  initialOps: Op[];
  onReady?: (quill: Quill) => void;
  /** Fires after every user edit (already post-processed: no inherited marks, unreviewed marks cleared on touched lines). */
  onUserChange?: (quill: Quill, change: Delta) => void;
  /** Overlay UI (hunk controls) rendered above the editor; receives a tick that changes on every text-change. */
  overlay?: (quill: Quill, tick: number) => ReactNode;
  /** A final report: Quill drops user edits (design 02 §5.2); `api` changes still apply. */
  readOnly?: boolean;
};

/**
 * Uncontrolled Quill mount (the canonical React pattern from Quill's own playground):
 * Quill owns the DOM inside the container; React never re-renders it. Re-mount with a
 * `key` to load a different report.
 */
export function ReportEditor({ initialOps, onReady, onUserChange, overlay, readOnly = false }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onUserChangeRef = useRef(onUserChange);
  onUserChangeRef.current = onUserChange;
  const initialOpsRef = useRef(initialOps);
  const [quill, setQuill] = useState<Quill | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    registerReportBlots();
    const editorEl = container.appendChild(container.ownerDocument.createElement("div"));
    const q = new Quill(editorEl, {
      theme: "snow",
      debug: "warn",
      placeholder: "Report…",
      formats: REPORT_FORMATS,
      modules: {
        toolbar: [["bold", "italic"], [{ list: "ordered" }, { list: "bullet" }]],
        // Undo only the radiologist's own edits; agent-applied changes are not in the user's history.
        history: { userOnly: true },
      },
    });
    q.setContents(initialOpsRef.current, "api");
    // The overlay re-positions on the next frame, not synchronously: Quill can emit a burst of
    // text-changes inside one event, and a React update per emit would chain commits.
    let frame = 0;
    q.on("text-change", (change, _old, source) => {
      if (source === "user") {
        afterUserChange(q, change);
        onUserChangeRef.current?.(q, change);
      }
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          setTick((t) => t + 1);
        });
      }
    });
    setQuill(q);
    onReadyRef.current?.(q);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      container.replaceChildren();
      setQuill(null);
    };
  }, []);

  useEffect(() => {
    quill?.enable(!readOnly);
  }, [quill, readOnly]);

  return (
    <div className={`relative flex h-full flex-col ${readOnly ? "report-final" : ""}`}>
      <div ref={containerRef} className="report-editor flex h-full flex-col" />
      {quill && overlay ? <div className="pointer-events-none absolute inset-0">{overlay(quill, tick)}</div> : null}
    </div>
  );
}
