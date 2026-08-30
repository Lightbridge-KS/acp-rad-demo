import { describe, expect, it } from "vitest";
import { ProposalStore, answerFor, type PermissionOption } from "./proposals.ts";

const ACC = "ACC1";
const SECTION = "/worklist/ACC1/sections/impression.md";
const CURRENT = "**IMPRESSION:**\n- ...\n";
const CLINICAL: PermissionOption[] = [
  { optionId: "accept", name: "Accept", kind: "allow_once" },
  { optionId: "accept_edit", name: "Accept for review", kind: "allow_once" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
];
const LEVEL0: PermissionOption[] = [
  { optionId: "allow", name: "Allow Once", kind: "allow_once" },
  { optionId: "allow_always", name: "Always Allow", kind: "allow_always" },
  { optionId: "reject", name: "Deny", kind: "reject_once" },
];

describe("ProposalStore", () => {
  it("a write that already matches the buffer registers nothing pending (an idempotent /template must not dirty the case)", () => {
    const store = new ProposalStore(ACC);
    const p = store.fromLocal("cmd-template-1", "/worklist/ACC1/report.md", CURRENT, CURRENT, { command: "template" })!;
    expect(p.hunks).toHaveLength(0);
    expect(p.state).toBe("applied");
    expect(store.pending()).toEqual([]);
  });

  it("builds hunks from an edit diff and answers when all are decided", async () => {
    const store = new ProposalStore(ACC);
    const p = store.fromDiff("call-1", { path: SECTION, oldText: "- ...", newText: "- A.\n- B." }, CURRENT)!;
    expect(p.section).toBe("impression");
    expect(p.hunks).toHaveLength(1);
    const answer = store.awaitPermission("call-1", CLINICAL);
    store.decide("call-1", p.hunks[0]!.id, "accept_edit");
    await expect(answer).resolves.toEqual({ outcome: "selected", optionId: "accept_edit" });
    const grant = store.takeGrant(SECTION)!;
    expect(grant.expected).toBe("**IMPRESSION:**\n- A.\n- B.\n");
    expect(grant.accepted).toEqual([p.hunks[0]!.id]);
    expect(store.takeGrant(SECTION)).toBeUndefined(); // single-use
  });

  it("filters allow_always and maps onto a Level 0 agent's options by kind", async () => {
    const store = new ProposalStore(ACC);
    const p = store.fromDiff("c", { path: SECTION, oldText: "- ...", newText: "- A." }, CURRENT)!;
    const answer = store.awaitPermission("c", LEVEL0);
    expect(p.options?.map((o) => o.optionId)).toEqual(["allow", "reject"]);
    store.decide("c", p.hunks[0]!.id, "accept");
    await expect(answer).resolves.toEqual({ outcome: "selected", optionId: "allow" });
  });

  it("all discarded ⇒ reject and no grant", async () => {
    const store = new ProposalStore(ACC);
    const p = store.fromDiff("c", { path: SECTION, oldText: "- ...", newText: "- A." }, CURRENT)!;
    const answer = store.awaitPermission("c", CLINICAL);
    store.decideAll("c", "reject");
    await expect(answer).resolves.toEqual({ outcome: "selected", optionId: "reject" });
    expect(store.takeGrant(SECTION)).toBeUndefined();
    expect(p.state).toBe("decided");
  });

  it("partial acceptance: accept on the wire, grant expects the full edit, write outcome is partial", async () => {
    const store = new ProposalStore(ACC);
    // Two changed lines separated by an unchanged one ⇒ two hunks (adjacent changes coalesce).
    const current = "**FINDINGS:**\n**Liver:** Normal.\n**Spleen:** Normal.\n**Bone:** Normal.\n";
    const p = store.fromDiff(
      "c",
      {
        path: "/worklist/ACC1/sections/findings.md",
        oldText: "**Liver:** Normal.\n**Spleen:** Normal.\n**Bone:** Normal.",
        newText: "**Liver:** Big.\n**Spleen:** Normal.\n**Bone:** Broken.",
      },
      current,
    )!;
    expect(p.hunks).toHaveLength(2);
    const answer = store.awaitPermission("c", CLINICAL);
    store.decide("c", p.hunks[0]!.id, "accept");
    store.decide("c", p.hunks[1]!.id, "reject");
    await expect(answer).resolves.toEqual({ outcome: "selected", optionId: "accept" });
    const grant = store.takeGrant("/worklist/ACC1/sections/findings.md")!;
    expect(grant.discarded).toEqual([p.hunks[1]!.id]);
    // the agent writes the FULL edit; the editor kept only hunk 1 ⇒ partial
    expect(store.outcomeFor(grant, "**FINDINGS:**\n**Liver:** Big.\n**Spleen:** Normal.\n**Bone:** Broken.\n")).toBe("partial");
    expect(p.state).toBe("partial");
  });

  it("applied when the write equals the full-accept expectation", async () => {
    const store = new ProposalStore(ACC);
    const p = store.fromDiff("c", { path: SECTION, oldText: "- ...", newText: "- A." }, CURRENT)!;
    const answer = store.awaitPermission("c", CLINICAL);
    store.decideAll("c", "accept");
    await answer;
    const grant = store.takeGrant(SECTION)!;
    expect(store.outcomeFor(grant, "**IMPRESSION:**\n- A.  \n")).toBe("applied"); // canonicalized compare
    expect(p.state).toBe("applied");
  });

  it("a conflicting only hunk answers reject; cancel answers cancelled", async () => {
    const store = new ProposalStore(ACC);
    const p = store.fromDiff("c", { path: SECTION, oldText: "- ...", newText: "- A." }, CURRENT)!;
    const answer = store.awaitPermission("c", CLINICAL);
    store.markConflicts("c", [p.hunks[0]!.id]);
    await expect(answer).resolves.toEqual({ outcome: "selected", optionId: "reject" });

    const store2 = new ProposalStore(ACC);
    store2.fromDiff("d", { path: SECTION, oldText: "- ...", newText: "- A." }, CURRENT);
    const pending = store2.awaitPermission("d", CLINICAL);
    store2.cancelAll();
    await expect(pending).resolves.toEqual({ outcome: "cancelled" });
  });

  it("an open grant serves the base text for reads and expires", async () => {
    const store = new ProposalStore(ACC);
    store.fromDiff("c", { path: SECTION, oldText: "- ...", newText: "- A." }, CURRENT);
    const answer = store.awaitPermission("c", CLINICAL);
    store.decideAll("c", "accept");
    await answer;
    expect(store.peekGrant(SECTION)?.baseText).toBe(CURRENT); // the agent re-reads what it was shown
    expect(store.peekGrant(SECTION, Date.now() + 61_000)).toBeUndefined(); // expired
    expect(store.takeGrant(SECTION)).toBeUndefined(); // dropped on expiry
  });

  it("a proposal decided before its permission request is answered when the request arrives", async () => {
    const store = new ProposalStore(ACC);
    const p = store.fromDiff("early", { path: SECTION, oldText: "- ...", newText: "- A." }, CURRENT)!;
    store.decideAll("early", "accept_edit"); // radiologist is faster than the agent's interrupt
    expect(p.state).toBe("decided");
    expect(store.takeGrant(SECTION)).toBeUndefined(); // no grant until the agent asks
    expect(store.matchPending(SECTION, "- ...", "- A.")?.toolCallId).toBe("early"); // the late request still finds it
    await expect(store.awaitPermission("early", CLINICAL)).resolves.toEqual({ outcome: "selected", optionId: "accept_edit" });
    expect(store.takeGrant(SECTION)?.expected).toBe("**IMPRESSION:**\n- A.\n");
    expect(store.matchPending(SECTION)).toBeUndefined(); // answered proposals are no longer candidates
  });

  it("matchPending correlates a permission request by path and snippets", () => {
    const store = new ProposalStore(ACC);
    const a = store.fromDiff("a", { path: SECTION, oldText: "- ...", newText: "- A." }, CURRENT)!;
    const b = store.fromDiff("b", { path: SECTION, oldText: "- ...", newText: "- B." }, CURRENT)!;
    expect(store.matchPending(SECTION, "- ...", "- A.")?.toolCallId).toBe(a.toolCallId);
    expect(store.matchPending(SECTION, "- ...", "- B.")?.toolCallId).toBe(b.toolCallId);
    expect(store.matchPending(SECTION)?.toolCallId).toBe(b.toolCallId); // newest when no snippets
    expect(store.matchPending("/worklist/ACC1/sections/findings.md")).toBeUndefined();
  });

  it("fromWrite synthesizes hunks against the current file; RO paths are refused", () => {
    const store = new ProposalStore(ACC);
    const p = store.fromWrite("w", SECTION, "**IMPRESSION:**\n- Z.\n", CURRENT)!;
    expect(p.hunks[0]!.oldLines).toEqual(["- ..."]);
    expect(p.hunks[0]!.newLines).toEqual(["- Z."]);
    expect(store.fromWrite("w2", "/templates/x.md", "x", "")).toBeNull();
  });
});

describe("answerFor", () => {
  const base = { toolCallId: "t", origin: "agent" as const, path: SECTION, section: "impression" as const, hunks: [], baseText: "", state: "pending" as const, createdAt: "" };
  it("prefers accept_edit when any hunk was accepted for review", () => {
    expect(answerFor({ ...base, states: { h1: "accept_edit" }, options: CLINICAL }, true)).toEqual({ outcome: "selected", optionId: "accept_edit" });
    expect(answerFor({ ...base, states: { h1: "accept" }, options: CLINICAL }, true)).toEqual({ outcome: "selected", optionId: "accept" });
  });
  it("cancels when no usable option exists", () => {
    expect(answerFor({ ...base, states: {}, options: [] }, true)).toEqual({ outcome: "cancelled" });
  });
});

describe("local proposals (editor commands, option C)", () => {
  const REPORT = "/worklist/ACC1/report.md";
  const CURRENT_REPORT = "**T**\n\n**IMPRESSION:**\n- ...\n";
  const NEXT = "**T**\n\n**HISTORY:** ___\n\n**IMPRESSION:**\n- ...\n";

  it("is decided in the report with no grant and no permission answer", async () => {
    const store = new ProposalStore(ACC);
    const events: string[] = [];
    store.subscribe((e) => events.push(e.type));
    const p = store.fromLocal("cmd-1", REPORT, NEXT, CURRENT_REPORT, { command: "template" })!;
    expect(p.origin).toBe("local");
    expect(p.section).toBeNull();
    await expect(store.awaitPermission("cmd-1", CLINICAL)).resolves.toEqual({ outcome: "cancelled" });
    store.decideAll("cmd-1", "accept_edit");
    expect(Object.values(p.states)).toEqual(["accept"]); // house text never lands unreviewed
    expect(p.state).toBe("applied");
    expect(store.takeGrant(REPORT)).toBeUndefined();
    expect(events).toEqual(["proposed", "decided", "write"]);
  });

  it("is invisible to the agent's permission matching and survives the agent's cancel", () => {
    const store = new ProposalStore(ACC);
    store.fromLocal("cmd-1", REPORT, NEXT, CURRENT_REPORT, { command: "template" });
    expect(store.matchPending(REPORT)).toBeUndefined();
    const agentP = store.fromDiff("a", { path: REPORT, oldText: "- ...", newText: "- A." }, CURRENT_REPORT)!;
    expect(store.matchPending(REPORT)?.toolCallId).toBe(agentP.toolCallId);
    store.cancelAll();
    expect(store.get("a")?.state).toBe("cancelled");
    expect(store.get("cmd-1")?.state).toBe("pending");
  });
});
