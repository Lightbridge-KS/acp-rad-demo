import { describe, expect, it } from "vitest";
import type { Flag } from "./flags.ts";
import { GATE_IDLE, gateStep, type GateAction, type GateEffect, type GateState } from "./qaGate.ts";

const flag = (id: string): Flag => ({ id, kind: "discrepancy", summary: id, locations: [], state: "open", raisedAt: "t" });

const start = (over: Partial<Extract<GateAction, { type: "start" }>> = {}): GateAction => ({
  type: "start",
  transition: "signoff",
  gate: { ok: true },
  shortPrelim: false,
  agentLevel: 2,
  flagCount: 0,
  ...over,
});

/** Run actions in sequence, collecting every effect. */
function run(actions: GateAction[], from: GateState = GATE_IDLE): { state: GateState; effects: GateEffect[] } {
  let state = from;
  const effects: GateEffect[] = [];
  for (const a of actions) {
    const step = gateStep(state, a);
    state = step.state;
    effects.push(...step.effects);
  }
  return { state, effects };
}

describe("QA gate — deterministic refusal and exemptions", () => {
  it("refuses with the blockers and audits qa.refused; dismiss returns to idle", () => {
    const blockers = [{ kind: "pending" as const, count: 2 }, { kind: "blank" as const, count: 3 }];
    const r = run([start({ gate: { ok: false, blockers } })]);
    expect(r.state).toEqual({ phase: "refused", transition: "signoff", blockers });
    expect(r.effects).toEqual([{ type: "audit", event: "qa.refused", outcome: "2 pending changes · 3 blanks left" }]);
    expect(gateStep(r.state, { type: "dismiss" }).state).toEqual(GATE_IDLE);
  });

  it("a short prelim gets the deterministic gate only: transition, audited qa.skipped{short_prelim}", () => {
    const r = run([start({ transition: "prelim", shortPrelim: true })]);
    expect(r.state).toEqual(GATE_IDLE);
    expect(r.effects).toEqual([
      { type: "audit", event: "qa.skipped", outcome: "short_prelim" },
      { type: "transition", status: "preliminary" },
    ]);
  });

  it("no agent → unavailable{agent_absent}; Level < 2 → unavailable{level}; override proceeds audited qa.skipped", () => {
    const absent = run([start({ agentLevel: undefined })]);
    expect(absent.state).toEqual({ phase: "unavailable", transition: "signoff", reason: "agent_absent" });
    expect(absent.effects).toEqual([]);
    const l1 = run([start({ agentLevel: 1 })]);
    expect(l1.state).toEqual({ phase: "unavailable", transition: "signoff", reason: "level" });
    const over = gateStep(l1.state, { type: "override" });
    expect(over.state).toEqual(GATE_IDLE);
    expect(over.effects).toEqual([
      { type: "audit", event: "qa.skipped", outcome: "level" },
      { type: "transition", status: "final" },
    ]);
  });
});

describe("QA gate — the agent turn", () => {
  it("starts the /qa turn remembering how many flags existed", () => {
    const r = run([start({ flagCount: 2 })]);
    expect(r.state).toEqual({ phase: "running", transition: "signoff", flagsBefore: 2 });
    expect(r.effects).toEqual([{ type: "prompt", text: "/qa" }]);
  });

  it("0 new flags → transition, audited qa.passed (pre-existing flags do not count)", () => {
    const r = run([start({ flagCount: 1 }), { type: "turn_end", stopReason: "end_turn", flags: [flag("f1")] }]);
    expect(r.state).toEqual(GATE_IDLE);
    expect(r.effects.slice(1)).toEqual([
      { type: "audit", event: "qa.passed" },
      { type: "transition", status: "final" },
    ]);
  });

  it("n new flags → flagged with their ids; Review returns to idle without audit", () => {
    const flags = [flag("f9"), flag("f10"), flag("f11")];
    const r = run([start({ flagCount: 1 }), { type: "turn_end", stopReason: "end_turn", flags }]);
    expect(r.state).toEqual({ phase: "flagged", transition: "signoff", flagIds: ["f10", "f11"] });
    const review = gateStep(r.state, { type: "review" });
    expect(review).toEqual({ state: GATE_IDLE, effects: [] });
  });

  it("Sign off anyway over flags → transition, audited qa.overridden{flagIds}", () => {
    const r = run([start(), { type: "turn_end", stopReason: "end_turn", flags: [flag("f1")] }, { type: "override" }]);
    expect(r.state).toEqual(GATE_IDLE);
    expect(r.effects.slice(1)).toEqual([
      { type: "audit", event: "qa.overridden", flagIds: ["f1"] },
      { type: "transition", status: "final" },
    ]);
  });

  it("a cancelled or errored turn → unavailable with that reason", () => {
    expect(run([start(), { type: "turn_end", stopReason: "cancelled", flags: [] }]).state).toEqual({ phase: "unavailable", transition: "signoff", reason: "cancelled" });
    expect(run([start(), { type: "turn_end", stopReason: "error", flags: [] }]).state).toEqual({ phase: "unavailable", transition: "signoff", reason: "error" });
  });

  it("timeout → unavailable{timeout}; override then cancels the running turn first", () => {
    const r = run([start(), { type: "timeout" }]);
    expect(r.state).toEqual({ phase: "unavailable", transition: "signoff", reason: "timeout" });
    const over = gateStep(r.state, { type: "override" });
    expect(over.effects).toEqual([
      { type: "cancel" },
      { type: "audit", event: "qa.skipped", outcome: "timeout" },
      { type: "transition", status: "final" },
    ]);
  });

  it("Prelim runs the agent gate too and lands on preliminary", () => {
    const r = run([start({ transition: "prelim" }), { type: "turn_end", stopReason: "end_turn", flags: [] }]);
    expect(r.effects.at(-1)).toEqual({ type: "transition", status: "preliminary" });
  });
});

describe("QA gate — stray events are no-ops", () => {
  it("turn_end while idle, flagged or unavailable changes nothing (a late /qa after timeout, a hand-typed /qa)", () => {
    const end: GateAction = { type: "turn_end", stopReason: "end_turn", flags: [flag("f1")] };
    expect(gateStep(GATE_IDLE, end)).toEqual({ state: GATE_IDLE, effects: [] });
    const flagged: GateState = { phase: "flagged", transition: "signoff", flagIds: ["f1"] };
    expect(gateStep(flagged, end)).toEqual({ state: flagged, effects: [] });
    const timedOut: GateState = { phase: "unavailable", transition: "signoff", reason: "timeout" };
    expect(gateStep(timedOut, end)).toEqual({ state: timedOut, effects: [] });
  });

  it("start while not idle, timeout while not running, dismiss while running: no-ops", () => {
    const running = run([start()]).state;
    expect(gateStep(running, start())).toEqual({ state: running, effects: [] });
    expect(gateStep(running, { type: "dismiss" })).toEqual({ state: running, effects: [] });
    expect(gateStep(GATE_IDLE, { type: "timeout" })).toEqual({ state: GATE_IDLE, effects: [] });
    expect(gateStep(GATE_IDLE, { type: "override" })).toEqual({ state: GATE_IDLE, effects: [] });
  });
});
