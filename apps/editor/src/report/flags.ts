/**
 * FlagStore — the editor's side of the agent's second channel (design 04 §3.5).
 *
 * A flag is what the agent raises when QA finds the report wanting: a kind, a one-line summary,
 * the lines concerned. It changes nothing in the report; the radiologist acknowledges it. Unlike
 * a proposal, a flag belongs to the radiologist the moment it is raised: nothing here is cancelled
 * by the agent's turn ending or the connection closing. Framework-free; React subscribes.
 */
import type { FlagKind, FlagLocation } from "acp-rad";

export type FlagState = "open" | "acknowledged";

export type Flag = {
  id: string;
  kind: FlagKind;
  summary: string;
  locations: FlagLocation[];
  state: FlagState;
  raisedAt: string;
  acknowledgedAt?: string;
};

export type FlagInput = { kind: FlagKind; summary: string; locations: FlagLocation[] };

export type FlagEvent = { type: "raised"; flag: Flag } | { type: "acknowledged"; flag: Flag };

export class FlagStore {
  private readonly flags = new Map<string, Flag>();
  private readonly listeners = new Set<(e: FlagEvent) => void>();
  private counter = 0;

  subscribe(fn: (e: FlagEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Record a raised flag; ids are `f{n}` in arrival order. */
  raise(input: FlagInput): Flag {
    this.counter += 1;
    const flag: Flag = {
      id: `f${this.counter}`,
      kind: input.kind,
      summary: input.summary,
      locations: [...input.locations],
      state: "open",
      raisedAt: new Date().toISOString(),
    };
    this.flags.set(flag.id, flag);
    this.emit({ type: "raised", flag });
    return flag;
  }

  /** The radiologist's act; idempotent. Returns the flag, or `undefined` for an unknown id. */
  acknowledge(id: string): Flag | undefined {
    const flag = this.flags.get(id);
    if (!flag) return undefined;
    if (flag.state === "acknowledged") return flag;
    flag.state = "acknowledged";
    flag.acknowledgedAt = new Date().toISOString();
    this.emit({ type: "acknowledged", flag });
    return flag;
  }

  get(id: string): Flag | undefined {
    return this.flags.get(id);
  }

  list(): Flag[] {
    return [...this.flags.values()];
  }

  open(): Flag[] {
    return this.list().filter((f) => f.state === "open");
  }

  private emit(e: FlagEvent): void {
    for (const fn of this.listeners) fn(e);
  }
}
