/**
 * The sidebar mirrors an ACP turn: text streams, a read card completes, an edit card with a
 * diff goes `requires-action` on the permission request and resolves from an EXTERNAL
 * decision (the editor's), never from the sidebar itself (ADR 0001, model B).
 */
import type * as acp from "@assistant-ui/react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useReducer } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Command, CommandGroups } from "../commands/registry.ts";
import { Sidebar, type AgentPort } from "./Sidebar.tsx";
import { initialSidebarState, sidebarReducer, type SidebarAction } from "./store.ts";

let dispatchRef: ((a: SidebarAction) => void) | null = null;

function Harness({ agent, commands, onCommand }: { agent: AgentPort; commands?: () => CommandGroups; onCommand?: (c: Command) => void }) {
  const [state, dispatch] = useReducer(sidebarReducer, initialSidebarState);
  dispatchRef = dispatch;
  return (
    <Sidebar
      state={state}
      dispatch={dispatch}
      header={{ status: "ready", agentName: "rad-report-agent", level: 1, model: "gpt-5" }}
      agent={agent}
      audit={[]}
      commands={commands}
      onCommand={onCommand}
    />
  );
}

const update = (u: unknown) => act(() => dispatchRef!({ type: "update", update: u as never }));

describe("Sidebar", () => {
  it("streams text, mirrors tool cards and an externally resolved permission", async () => {
    const agent: AgentPort = { prompt: vi.fn(async () => {}), cancel: vi.fn(async () => {}) };
    render(<Harness agent={agent} />);

    act(() => dispatchRef!({ type: "user", text: "Draft the impression" }));
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Reading " } });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "findings…" } });
    expect(screen.getByText("Reading findings…")).toBeTruthy();

    update({ sessionUpdate: "tool_call", toolCallId: "r1", title: "Read `/worklist/A/sections/findings.md`", kind: "read", status: "pending", content: [] });
    update({ sessionUpdate: "tool_call_update", toolCallId: "r1", status: "completed" });
    update({
      sessionUpdate: "tool_call",
      toolCallId: "e1",
      title: "Edit `/worklist/A/sections/impression.md`",
      kind: "edit",
      status: "pending",
      content: [{ type: "diff", path: "/worklist/A/sections/impression.md", oldText: "- ...", newText: "- Acute infarct." }],
    });
    const cards = screen.getAllByTestId("tool");
    expect(cards).toHaveLength(2);
    expect(cards[0]!.getAttribute("data-status")).toBe("complete");

    act(() =>
      dispatchRef!({
        type: "permission_requested",
        toolCallId: "e1",
        options: [
          { optionId: "accept", name: "Accept", kind: "allow_once" },
          { optionId: "accept_edit", name: "Accept for review", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      }),
    );
    expect(screen.getAllByTestId("tool")[1]!.getAttribute("data-status")).toBe("requires-action");
    expect(screen.getByTestId("decision").textContent).toMatch(/awaiting your decision in the report/);
    // No approve/reject buttons are rendered by the sidebar — the decision is the editor's.
    expect(screen.queryByRole("button", { name: /Accept|Reject|Allow|Deny/ })).toBeNull();

    act(() => dispatchRef!({ type: "permission_resolved", toolCallId: "e1", optionId: "accept_edit" }));
    update({ sessionUpdate: "tool_call_update", toolCallId: "e1", status: "completed" });
    act(() => dispatchRef!({ type: "turn_end", stopReason: "end_turn" }));
    expect(screen.getByTestId("decision").textContent).toMatch(/accepted for review/);
    expect(screen.getAllByTestId("tool")[1]!.getAttribute("data-status")).toBe("complete");
  });

  it("composer sends through the AgentPort and Stop cancels", async () => {
    const agent: AgentPort = { prompt: vi.fn(async () => {}), cancel: vi.fn(async () => {}) };
    render(<Harness agent={agent} />);
    const input = screen.getByPlaceholderText(/Ask the agent/);
    fireEvent.change(input, { target: { value: "hello" } });
    await act(async () => {
      fireEvent.click(screen.getByText("Send"));
    });
    expect(agent.prompt).toHaveBeenCalledWith("hello");
    await act(async () => {
      fireEvent.click(screen.getByText("Stop"));
    });
    expect(agent.cancel).toHaveBeenCalledTimes(1);
  });

  it("marks a cancelled turn as stopped until the next prompt", () => {
    const agent: AgentPort = { prompt: vi.fn(async () => {}), cancel: vi.fn(async () => {}) };
    render(<Harness agent={agent} />);
    act(() => dispatchRef!({ type: "user", text: "/impression" }));
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Reading…" } });
    act(() => dispatchRef!({ type: "turn_end", stopReason: "cancelled" }));
    expect(screen.getByTestId("stopped").textContent).toBe("stopped");
    act(() => dispatchRef!({ type: "user", text: "again" }));
    expect(screen.queryByTestId("stopped")).toBeNull();
  });

  it("composer / lists the registry and runs the picked command", async () => {
    const agent: AgentPort = { prompt: vi.fn(async () => {}), cancel: vi.fn(async () => {}) };
    const onCommand = vi.fn();
    const groups: CommandGroups = {
      suggested: [],
      editor: [{ id: "template", kind: "document", description: "Scaffold the house template" }],
      skills: [{ id: "impression", kind: "skill", description: "Draft the impression" }],
    };
    render(<Harness agent={agent} commands={() => groups} onCommand={onCommand} />);
    const input = screen.getByPlaceholderText(/Ask the agent/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "/" } });
    input.setSelectionRange(1, 1);
    fireEvent.select(input);
    const item = await screen.findByText("/template");
    await act(async () => {
      fireEvent.click(item);
    });
    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ id: "template" }));
    expect(agent.prompt).not.toHaveBeenCalled();
  });
});

// keep the type import used (assistant-ui exports are type-checked through convert.ts)
export type _Acp = typeof acp;
