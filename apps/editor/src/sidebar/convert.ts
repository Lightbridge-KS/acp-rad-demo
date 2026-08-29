/**
 * The one file that knows assistant-ui's types (ADR 0001): projects our ACP-fed message
 * model onto `ThreadMessageLike`. A rename in the 0.15 line touches only this file.
 */
import type { ThreadMessageLike, ToolApprovalOption } from "@assistant-ui/react";
import type { AcpMessage, ToolCall } from "./store.ts";

type LikeToolCall = Extract<Extract<ThreadMessageLike, { role: "assistant" }>["content"], readonly unknown[]>[number] & { type: "tool-call" };

const optionKind = (kind: string): ToolApprovalOption["kind"] => kind.replaceAll("_", "-") as ToolApprovalOption["kind"];

const toToolPart = (c: ToolCall): LikeToolCall => {
  const p = c.permission;
  const outcome = p?.outcome;
  // deepagents-acp never sends a completion for edit_file; a resolved permission is the end of its story here.
  const done = c.status === "completed" || c.status === "failed" || outcome !== undefined;
  const chosen = outcome && "optionId" in outcome ? p.options.find((o) => o.optionId === outcome.optionId) : undefined;
  return {
    type: "tool-call",
    toolCallId: c.toolCallId,
    toolName: c.kind ?? "other",
    args: { title: c.title, ...(c.diff ? { path: c.diff.path } : {}) },
    artifact: c.diff, // the diff rides along for the card; the editor renders it in Quill
    result: done ? { status: c.status } : undefined,
    isError: c.status === "failed",
    ...(p && {
      approval: {
        id: c.toolCallId,
        options: p.options.map((o) => ({ id: o.optionId, kind: optionKind(o.kind), label: o.name })),
        ...(chosen && { approved: chosen.kind.startsWith("allow"), optionId: chosen.optionId }),
        ...(outcome && "cancelled" in outcome && { resolution: "cancelled" as const }),
      },
    }),
  } as LikeToolCall;
};

export const convertMessage = (m: AcpMessage): ThreadMessageLike => {
  if (m.role === "user") return { id: m.id, role: "user", content: [{ type: "text", text: m.text }] };
  const awaitingEditor = m.parts.some((p) => p.type === "tool" && p.call.permission && !p.call.permission.outcome);
  return {
    id: m.id,
    role: "assistant",
    content: m.parts.map((p) =>
      p.type === "text" ? { type: "text", text: p.text } : p.type === "reasoning" ? { type: "reasoning", text: p.text } : toToolPart(p.call),
    ),
    // Explicit status wins over the runtime's auto-status; otherwise auto (running while last+isRunning, complete after).
    status: awaitingEditor
      ? { type: "requires-action", reason: "interrupt" }
      : m.stopReason === "cancelled"
        ? { type: "incomplete", reason: "cancelled" }
        : undefined,
  };
};
