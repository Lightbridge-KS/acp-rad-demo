/**
 * The sidebar mirrors an ACP turn: text streams, a read card completes, an edit card with a
 * diff goes `requires-action` on the permission request and resolves from an EXTERNAL
 * decision (the editor's), never from the sidebar itself (ADR 0001, model B).
 */
import type * as acp from "@assistant-ui/react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useReducer } from "react";
import { describe, expect, it, vi } from "vitest";
import type { CommandGroups } from "../commands/registry.ts";
import type { Flag } from "../report/flags.ts";
import { Sidebar, type AgentPort, type HeaderState } from "./Sidebar.tsx";
import { initialSidebarState, sidebarReducer, type SidebarAction } from "./store.ts";

let dispatchRef: ((a: SidebarAction) => void) | null = null;

type HarnessProps = {
  agent: AgentPort;
  header?: HeaderState;
  commands?: () => CommandGroups;
  flags?: Flag[];
  onAcknowledge?: (id: string) => void;
  onLocate?: (id: string) => void;
  onReconnect?: () => void;
};

function Harness({ agent, header, commands, flags, onAcknowledge, onLocate, onReconnect }: HarnessProps) {
  const [state, dispatch] = useReducer(sidebarReducer, initialSidebarState);
  dispatchRef = dispatch;
  return (
    <Sidebar
      state={state}
      dispatch={dispatch}
      header={header ?? { status: "ready", agentName: "rad-report-agent", level: 1, model: "gpt-5" }}
      agent={agent}
      audit={[]}
      commands={commands}
      flags={flags}
      onAcknowledge={onAcknowledge}
      onLocate={onLocate}
      onReconnect={onReconnect}
    />
  );
}

const update = (u: unknown) => act(() => dispatchRef!({ type: "update", update: u as never }));

describe("Sidebar", () => {
  it("renders the model select from the session's configOptions and sends the choice through the port", () => {
    const setConfigOption = vi.fn(async () => {});
    const agent: AgentPort = { prompt: vi.fn(async () => "end_turn"), cancel: vi.fn(async () => {}), setConfigOption };
    const header: HeaderState = {
      status: "ready",
      agentName: "rad-report-agent",
      level: 2,
      model: "openai:stale",
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "openai:a",
          options: [
            { value: "openai:a", name: "openai:a" },
            { value: "anthropic:b", name: "anthropic:b" },
          ],
        },
      ],
    };
    render(<Harness agent={agent} header={header} />);
    const select = screen.getByTestId("model-select") as HTMLSelectElement;
    expect(select.value).toBe("openai:a");
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["openai:a", "anthropic:b"]);
    expect(screen.queryByText("· openai:stale")).toBeNull();
    fireEvent.change(select, { target: { value: "anthropic:b" } });
    expect(setConfigOption).toHaveBeenCalledWith("model", "anthropic:b");
  });

  it("streams text, mirrors tool cards and an externally resolved permission", async () => {
    const agent: AgentPort = { prompt: vi.fn(async () => "end_turn"), cancel: vi.fn(async () => {}), setConfigOption: vi.fn(async () => {}) };
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
    const agent: AgentPort = { prompt: vi.fn(async () => "end_turn"), cancel: vi.fn(async () => {}), setConfigOption: vi.fn(async () => {}) };
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
    const agent: AgentPort = { prompt: vi.fn(async () => "end_turn"), cancel: vi.fn(async () => {}), setConfigOption: vi.fn(async () => {}) };
    render(<Harness agent={agent} />);
    act(() => dispatchRef!({ type: "user", text: "/impression" }));
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Reading…" } });
    act(() => dispatchRef!({ type: "turn_end", stopReason: "cancelled" }));
    expect(screen.getByTestId("stopped").textContent).toBe("stopped");
    act(() => dispatchRef!({ type: "user", text: "again" }));
    expect(screen.queryByTestId("stopped")).toBeNull();
  });

  it("ends an unfinished turn on disconnect and offers only manual reconnect", () => {
    const agent: AgentPort = { prompt: vi.fn(async () => "end_turn"), cancel: vi.fn(async () => {}), setConfigOption: vi.fn(async () => {}) };
    const reconnect = vi.fn();
    const { rerender } = render(<Harness agent={agent} />);
    act(() => dispatchRef!({ type: "user", text: "draft" }));
    act(() => dispatchRef!({ type: "disconnect" }));
    expect((screen.getByText("Send") as HTMLButtonElement).disabled).toBe(true);
    rerender(<Harness agent={agent} header={{ status: "disconnected", error: "connection closed" }} onReconnect={reconnect} />);
    fireEvent.click(screen.getByTestId("reconnect-agent"));
    expect(reconnect).toHaveBeenCalledOnce();
  });

  it("shows open flags as cards and owns the Acknowledge decision; a raise_flag tool card reads 'flag'", () => {
    const agent: AgentPort = { prompt: vi.fn(async () => "end_turn"), cancel: vi.fn(async () => {}), setConfigOption: vi.fn(async () => {}) };
    const onAcknowledge = vi.fn();
    const onLocate = vi.fn();
    const flags: Flag[] = [
      { id: "f1", kind: "discrepancy", summary: "FINDINGS say right; IMPRESSION says left.", locations: [{ path: "/worklist/A/sections/impression.md", line: 2 }], state: "open", raisedAt: "t" },
      { id: "f2", kind: "critical_uncommunicated", summary: "Hyperdense M1 with no discussed-with line.", locations: [], state: "open", raisedAt: "t" },
    ];
    render(<Harness agent={agent} flags={flags} onAcknowledge={onAcknowledge} onLocate={onLocate} />);
    const cards = screen.getAllByTestId("flag");
    expect(cards).toHaveLength(2);
    expect(cards[0]!.getAttribute("data-kind")).toBe("discrepancy");
    expect(cards[0]!.textContent).toMatch(/sections\/impression\.md · line 2/);
    expect(cards[1]!.textContent).toMatch(/critical uncommunicated/);
    fireEvent.click(screen.getAllByTestId("acknowledge")[1]!);
    expect(onAcknowledge).toHaveBeenCalledWith("f2");
    fireEvent.click(screen.getByText(/FINDINGS say right/));
    expect(onLocate).toHaveBeenCalledWith("f1");
    // The proposal decision still never lives here.
    expect(screen.queryByRole("button", { name: /Accept|Reject|Allow|Deny/ })).toBeNull();

    update({ sessionUpdate: "tool_call", toolCallId: "q1", title: "raise_flag", kind: "other", status: "pending", content: [] });
    expect(screen.getByTestId("tool").textContent).toMatch(/^flag/);
  });

  it("composer / lists skills only, and picking one inserts a mention instead of sending", async () => {
    const agent: AgentPort = { prompt: vi.fn(async () => "end_turn"), cancel: vi.fn(async () => {}), setConfigOption: vi.fn(async () => {}) };
    const groups: CommandGroups = {
      suggested: [],
      editor: [{ id: "template", kind: "document", description: "Scaffold the house template" }],
      skills: [{ id: "impression", kind: "skill", description: "Draft the impression" }],
    };
    render(<Harness agent={agent} commands={() => groups} />);
    const input = screen.getByPlaceholderText(/Ask the agent/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Please explain the /" } });
    input.setSelectionRange(20, 20);
    fireEvent.select(input);
    const item = await screen.findByText("/impression");
    expect(screen.queryByText("/template")).toBeNull(); // editor commands are not chat
    await act(async () => {
      fireEvent.click(item);
    });
    // The mention lands in the sentence; the words around it survive, and nothing is sent yet —
    // the radiologist is still writing.
    expect(input.value).toContain("Please explain the /impression");
    expect(agent.prompt).not.toHaveBeenCalled();
  });

  it("composer / filters by the typed query, ranking the named skill first", async () => {
    const agent: AgentPort = { prompt: vi.fn(async () => "end_turn"), cancel: vi.fn(async () => {}), setConfigOption: vi.fn(async () => {}) };
    const groups: CommandGroups = {
      suggested: [],
      editor: [],
      skills: [
        { id: "compare", kind: "skill", description: "Compare with priors" },
        // Its description mentions the impression, so a description-only match would win.
        { id: "proofread", kind: "skill", description: "Fix wording; align the impression to the findings" },
        { id: "impression", kind: "skill", description: "Draft the impression" },
      ],
    };
    render(<Harness agent={agent} commands={() => groups} />);
    const input = screen.getByPlaceholderText(/Ask the agent/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "/impr" } });
    input.setSelectionRange(5, 5);
    fireEvent.select(input);
    const items = await screen.findAllByText(/^\/[a-z]+$/);
    expect(items[0]!.textContent).toBe("/impression");
    expect(items.map((i) => i.textContent)).not.toContain("/compare");
  });
});

// keep the type import used (assistant-ui exports are type-checked through convert.ts)
export type _Acp = typeof acp;
