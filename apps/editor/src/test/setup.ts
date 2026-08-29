import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom lacks the layout APIs Quill and ThreadPrimitive.Viewport touch.
class RO {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;
if (typeof Element !== "undefined") {
  Element.prototype.scrollTo = () => {};
  if (!document.getSelection) (document as unknown as { getSelection: () => null }).getSelection = () => null;
}

afterEach(() => cleanup());
