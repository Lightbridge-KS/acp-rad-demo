import Quill from "quill";
import "quill/dist/quill.snow.css";
import { useEffect, useRef } from "react";

/**
 * Formats a report may contain. Anything else (pasted or programmatic) is
 * stripped by Quill — the report document model is a whitelist, not a
 * free-for-all. `ai-draft` joins this list in slice 3.
 */
const REPORT_FORMATS = ["bold", "italic", "list", "header"];

type Props = {
  /** Plain text for slice 1; a canonical-Markdown → Delta loader replaces this in slice 2. */
  initialText: string;
  onReady?: (quill: Quill) => void;
};

/**
 * Uncontrolled Quill mount (the canonical React pattern from Quill's own
 * playground): Quill owns the DOM inside the container; React never re-renders it.
 * Re-mount with a `key` to load a different report.
 */
export function ReportEditor({ initialText, onReady }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const initialTextRef = useRef(initialText);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const editorEl = container.appendChild(container.ownerDocument.createElement("div"));
    const quill = new Quill(editorEl, {
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
    quill.setText(initialTextRef.current, "api");
    onReadyRef.current?.(quill);
    return () => {
      container.replaceChildren();
    };
  }, []);

  return <div ref={containerRef} className="report-editor flex h-full flex-col" />;
}
