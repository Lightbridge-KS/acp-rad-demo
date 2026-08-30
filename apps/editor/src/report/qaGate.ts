/**
 * The QA gate as a reducer (design 04 §3.5). Runs when the radiologist clicks Prelim / Sign off:
 * the deterministic result is handed in; the agent gate — send the literal `/qa`, count the
 * flags raised until the turn ends — is driven through declarative effects the caller executes.
 *
 * The gate is **advisory**: every non-passing phase offers an override, and only the override
 * is audited (`qa.overridden` with the flag ids, `qa.skipped` with the reason). Framework-free:
 * no Quill, no port, no store — the Workspace executes the effects and feeds events back.
 *
 * Late or foreign `turn_end`s are no-ops: after a timeout the `/qa` prompt still resolves later,
 * and a hand-typed `/qa` ends a turn while the gate is idle.
 */
import type { ProfileLevel, ReportStatus } from "acp-rad";
import type { Flag } from "./flags.ts";
import { describeBlockers, nextStatus, type Blocker, type GateResult, type Transition } from "./lifecycle.ts";

/** Why the agent gate did not decide — the `outcome` of `qa.skipped`. */
export type SkipReason = "short_prelim" | "agent_absent" | "level" | "timeout" | "cancelled" | "error";

export type GateState =
  | { phase: "idle" }
  | { phase: "refused"; transition: Transition; blockers: Blocker[] }
  | { phase: "running"; transition: Transition; flagsBefore: number }
  | { phase: "flagged"; transition: Transition; flagIds: string[] }
  | { phase: "unavailable"; transition: Transition; reason: SkipReason };

export type GateAction =
  | {
      type: "start";
      transition: Transition;
      gate: GateResult;
      shortPrelim: boolean;
      /** `undefined` = no agent connected */
      agentLevel: ProfileLevel | undefined;
      /** `flags.list().length` at the click — everything after it was raised by this turn */
      flagCount: number;
    }
  | { type: "turn_end"; stopReason: string; flags: Flag[] }
  | { type: "timeout" }
  | { type: "review" }
  | { type: "override" }
  | { type: "dismiss" };

export type GateEffect =
  | { type: "prompt"; text: "/qa" }
  | { type: "cancel" }
  | { type: "transition"; status: ReportStatus }
  | { type: "audit"; event: "qa.refused" | "qa.passed" | "qa.overridden" | "qa.skipped"; outcome?: string; flagIds?: string[] };

export type GateStep = { state: GateState; effects: GateEffect[] };

export const GATE_IDLE: GateState = { phase: "idle" };

/** How long the agent gate waits for `/qa` before offering the override (💡 KS: 90 s). */
export const GATE_TIMEOUT_MS = 90_000;

const stay = (state: GateState): GateStep => ({ state, effects: [] });

function proceed(transition: Transition, audit: GateEffect): GateStep {
  return { state: GATE_IDLE, effects: [audit, { type: "transition", status: nextStatus(transition) }] };
}

export function gateStep(state: GateState, action: GateAction): GateStep {
  switch (action.type) {
    case "start": {
      if (state.phase !== "idle") return stay(state);
      const { transition } = action;
      if (!action.gate.ok) {
        return {
          state: { phase: "refused", transition, blockers: action.gate.blockers },
          effects: [{ type: "audit", event: "qa.refused", outcome: describeBlockers(action.gate.blockers) }],
        };
      }
      // A short prelim exists to beat the clock: the deterministic gate is its whole gate.
      if (action.shortPrelim) return proceed(transition, { type: "audit", event: "qa.skipped", outcome: "short_prelim" });
      if (action.agentLevel === undefined) return stay({ phase: "unavailable", transition, reason: "agent_absent" });
      if (action.agentLevel < 2) return stay({ phase: "unavailable", transition, reason: "level" });
      return { state: { phase: "running", transition, flagsBefore: action.flagCount }, effects: [{ type: "prompt", text: "/qa" }] };
    }
    case "turn_end": {
      if (state.phase !== "running") return stay(state);
      const { transition } = state;
      if (action.stopReason === "cancelled") return stay({ phase: "unavailable", transition, reason: "cancelled" });
      if (action.stopReason === "error") return stay({ phase: "unavailable", transition, reason: "error" });
      const flagIds = action.flags.slice(state.flagsBefore).map((f) => f.id);
      if (flagIds.length === 0) return proceed(transition, { type: "audit", event: "qa.passed" });
      return stay({ phase: "flagged", transition, flagIds });
    }
    case "timeout":
      // The turn keeps running; only the override cancels it.
      return state.phase === "running" ? stay({ phase: "unavailable", transition: state.transition, reason: "timeout" }) : stay(state);
    case "review":
      // The cards are already in the strip; the radiologist goes to them.
      return state.phase === "flagged" ? stay(GATE_IDLE) : stay(state);
    case "override": {
      if (state.phase === "flagged") {
        return proceed(state.transition, { type: "audit", event: "qa.overridden", flagIds: state.flagIds });
      }
      if (state.phase === "unavailable") {
        const step = proceed(state.transition, { type: "audit", event: "qa.skipped", outcome: state.reason });
        // After a timeout the /qa turn is still in flight — stop it before the report goes out.
        if (state.reason === "timeout") step.effects.unshift({ type: "cancel" });
        return step;
      }
      return stay(state);
    }
    case "dismiss":
      return state.phase === "running" ? stay(state) : stay(GATE_IDLE);
  }
}
