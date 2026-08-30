import { describe, expect, it } from "vitest";
import { FlagStore, type FlagEvent } from "./flags.ts";

const input = (summary: string) => ({ kind: "discrepancy" as const, summary, locations: [{ path: "/worklist/A/sections/impression.md", line: 2 }] });

describe("FlagStore", () => {
  it("mints ids in arrival order and lists open flags", () => {
    const store = new FlagStore();
    const a = store.raise(input("left vs right"));
    const b = store.raise({ ...input("no discussed-with line"), kind: "critical_uncommunicated" });
    expect([a.id, b.id]).toEqual(["f1", "f2"]);
    expect(store.open().map((f) => f.id)).toEqual(["f1", "f2"]);
    expect(a.state).toBe("open");
    expect(a.locations).toEqual(input("").locations);
  });

  it("acknowledges once, idempotently, and emits events", () => {
    const store = new FlagStore();
    const events: FlagEvent[] = [];
    store.subscribe((e) => events.push(e));
    const f = store.raise(input("x"));
    expect(store.acknowledge(f.id)?.state).toBe("acknowledged");
    expect(store.acknowledge(f.id)?.state).toBe("acknowledged");
    expect(store.acknowledge("nope")).toBeUndefined();
    expect(store.open()).toEqual([]);
    expect(store.list()).toHaveLength(1);
    expect(events.map((e) => e.type)).toEqual(["raised", "acknowledged"]);
    expect(f.acknowledgedAt).toBeDefined();
  });
});
