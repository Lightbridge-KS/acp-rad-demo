import { describe, expect, it } from "vitest";
import { MemoryState } from "./state.ts";

describe("admission leases", () => {
  it("admits ten, rejects eleven, prunes expiry, renews, and releases", async () => {
    const state = new MemoryState();
    const now = 1_000;
    for (let index = 0; index < 10; index += 1) {
      await expect(state.acquireLease(`member-${index}`, now, 90_000, 10)).resolves.toBe(true);
    }
    await expect(state.acquireLease("eleventh", now, 90_000, 10)).resolves.toBe(false);
    await expect(state.renewLease("member-0", now + 30_000, 90_000)).resolves.toBe("renewed");
    await state.releaseLease("member-1");
    await expect(state.acquireLease("replacement", now + 30_000, 90_000, 10)).resolves.toBe(true);
    await expect(state.renewLease("replacement", now + 121_000, 90_000)).resolves.toBe("missing");
    await expect(state.acquireLease("after-expiry", now + 121_000, 90_000, 10)).resolves.toBe(true);
  });
});

describe("shared safeguards", () => {
  it("appends audit records by accession", async () => {
    const state = new MemoryState();
    await state.appendAudit("ACC-1", { event: "session.new" }, 604_800);
    expect(state.audits.get("ACC-1")).toEqual([{ event: "session.new" }]);
  });
});
