/**
 * ProposalStore — the editor's side of sign-off (design §5.7).
 *
 * One proposal per agent tool call. Hunks are decided in the report; when all are decided the
 * pending `session/request_permission` is answered, and a grant records what the agent's
 * subsequent `fs/write_text_file` is allowed to be. Framework-free; React subscribes via
 * `subscribe`.
 */
import { applyHunks, buildHunks, canonicalize, resolvePath, type Hunk, type SectionId } from "acp-rad";

export type Verb = "accept" | "accept_edit" | "reject";
export type HunkState = "pending" | "conflict" | Verb;

export type PermissionOption = { optionId: string; name: string; kind: string };
export type PermissionAnswer = { outcome: "selected"; optionId: string } | { outcome: "cancelled" };

export type Proposal = {
  toolCallId: string;
  path: string;
  section: SectionId | null;
  hunks: Hunk[];
  /** Section (or whole report) canonical text when the proposal was built. */
  baseText: string;
  states: Record<string, HunkState>;
  state: "pending" | "decided" | "applied" | "partial" | "cancelled";
  options?: PermissionOption[];
  createdAt: string;
};

export type Grant = {
  toolCallId: string;
  path: string;
  /** What the buffer holds after the radiologist's decisions (accepted hunks applied). */
  expected: string;
  /**
   * The section as the agent was shown it. Served for reads of `path` while the grant is
   * open, so the agent's read-modify-write reproduces the edit it proposed instead of
   * failing to find `old_string` in the already-updated buffer.
   */
  baseText: string;
  accepted: string[];
  discarded: string[];
  createdAt: number;
};

/** A grant is single-use and short-lived: the agent's write follows its approval within seconds. */
export const GRANT_TTL_MS = 60_000;

export type ProposalEvent =
  | { type: "proposed"; proposal: Proposal }
  | { type: "decided"; proposal: Proposal; hunkId: string; verb: Verb }
  | { type: "answered"; proposal: Proposal; answer: PermissionAnswer }
  | { type: "write"; proposal: Proposal; outcome: "applied" | "partial" }
  | { type: "cancelled"; proposal: Proposal };

type Waiter = (answer: PermissionAnswer) => void;

export class ProposalStore {
  private readonly proposals = new Map<string, Proposal>();
  private readonly waiters = new Map<string, Waiter>();
  private readonly grants = new Map<string, Grant>(); // by path
  private readonly listeners = new Set<(e: ProposalEvent) => void>();
  private counter = 0;
  private readonly accession: string;

  constructor(accession: string) {
    this.accession = accession;
  }

  subscribe(fn: (e: ProposalEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  list(): Proposal[] {
    return [...this.proposals.values()];
  }

  get(toolCallId: string): Proposal | undefined {
    return this.proposals.get(toolCallId);
  }

  pending(): Proposal[] {
    return this.list().filter((p) => p.state === "pending");
  }

  /**
   * Find the pending proposal a permission request refers to when its `toolCallId` differs
   * from the streamed tool call's (deepagents-acp mints a fresh id for the interrupt):
   * match on the path and, when given, the exact old/new snippets.
   */
  matchPending(path: string, oldText?: string | null, newText?: string | null): Proposal | undefined {
    const candidates = this.pending().filter((p) => p.path === path && !p.options);
    if (candidates.length === 0) return undefined;
    if (oldText == null && newText == null) return candidates[candidates.length - 1];
    const want = buildHunks(oldText ?? "", newText ?? "").map((h) => `${h.oldLines.join("\n")}→${h.newLines.join("\n")}`).join("|");
    const exact = candidates.find(
      (p) => p.hunks.map((h) => `${h.oldLines.join("\n")}→${h.newLines.join("\n")}`).join("|") === want,
    );
    return exact ?? candidates[candidates.length - 1];
  }

  /** From an ACP `diff` content block (edit_file: old/new are the tool's snippets). */
  fromDiff(toolCallId: string, diff: { path: string; oldText: string | null; newText: string }, currentFile: string): Proposal | null {
    const r = resolvePath(diff.path, this.accession);
    if (!r || (r.kind !== "section" && r.kind !== "report")) return null;
    const oldText = diff.oldText ?? "";
    const hunks = buildHunks(oldText, diff.newText, `${this.nextPrefix()}`);
    return this.add(toolCallId, diff.path, r.kind === "section" ? r.id : null, hunks, currentFile);
  }

  /** From a whole-file write (write_file, or an unsolicited fs/write_text_file). */
  fromWrite(toolCallId: string, path: string, content: string, currentFile: string): Proposal | null {
    const r = resolvePath(path, this.accession);
    if (!r || (r.kind !== "section" && r.kind !== "report")) return null;
    const hunks = buildHunks(currentFile, content, `${this.nextPrefix()}`);
    return this.add(toolCallId, path, r.kind === "section" ? r.id : null, hunks, currentFile);
  }

  /** Attach the agent's permission request; resolves when every hunk is decided (or on cancel). */
  awaitPermission(toolCallId: string, options: PermissionOption[]): Promise<PermissionAnswer> {
    const p = this.proposals.get(toolCallId);
    if (!p) return Promise.resolve({ outcome: "cancelled" });
    p.options = options.filter((o) => o.kind !== "allow_always" && o.kind !== "reject_always"); // INV-1
    return new Promise((resolve) => {
      this.waiters.set(toolCallId, resolve);
      if (this.allDecided(p)) this.answer(p);
    });
  }

  /** Mark hunks whose anchor could not be found in the live report. */
  markConflicts(toolCallId: string, hunkIds: string[]): void {
    const p = this.proposals.get(toolCallId);
    if (!p) return;
    for (const id of hunkIds) p.states[id] = "conflict";
    if (this.allDecided(p)) this.answer(p);
  }

  decide(toolCallId: string, hunkId: string, verb: Verb): Proposal | undefined {
    const p = this.proposals.get(toolCallId);
    if (!p || p.state !== "pending" || !(hunkId in p.states)) return p;
    p.states[hunkId] = verb;
    this.emit({ type: "decided", proposal: p, hunkId, verb });
    if (this.allDecided(p)) this.answer(p);
    return p;
  }

  decideAll(toolCallId: string, verb: Verb): void {
    const p = this.proposals.get(toolCallId);
    if (!p) return;
    for (const h of p.hunks) if (p.states[h.id] === "pending") this.decide(toolCallId, h.id, verb);
  }

  /** `session/cancel` or connection loss: answer `cancelled`, drop the proposal. */
  cancel(toolCallId: string): void {
    const p = this.proposals.get(toolCallId);
    if (!p) return;
    p.state = "cancelled";
    this.waiters.get(toolCallId)?.({ outcome: "cancelled" });
    this.waiters.delete(toolCallId);
    this.emit({ type: "cancelled", proposal: p });
  }

  cancelAll(): void {
    for (const p of this.pending()) this.cancel(p.toolCallId);
  }

  /** Grant lookup for an incoming write; single-use. */
  takeGrant(path: string, now = Date.now()): Grant | undefined {
    const g = this.peekGrant(path, now);
    if (g) this.grants.delete(path);
    return g;
  }

  /** Open grant for `path`, if any and not expired (expired grants are dropped). */
  peekGrant(path: string, now = Date.now()): Grant | undefined {
    const g = this.grants.get(path);
    if (!g) return undefined;
    if (now - g.createdAt > GRANT_TTL_MS) {
      this.grants.delete(path);
      return undefined;
    }
    return g;
  }

  /** Compare an agent write with its grant. */
  outcomeFor(grant: Grant, content: string): "applied" | "partial" {
    const outcome = canonicalize(content) === grant.expected ? "applied" : "partial";
    const p = this.proposals.get(grant.toolCallId);
    if (p) {
      p.state = outcome;
      this.emit({ type: "write", proposal: p, outcome });
    }
    return outcome;
  }

  // -- internals -------------------------------------------------------------

  private add(toolCallId: string, path: string, section: SectionId | null, hunks: Hunk[], baseText: string): Proposal {
    const p: Proposal = {
      toolCallId,
      path,
      section,
      hunks,
      baseText,
      states: Object.fromEntries(hunks.map((h) => [h.id, "pending" as HunkState])),
      state: "pending",
      createdAt: new Date().toISOString(),
    };
    this.proposals.set(toolCallId, p);
    this.emit({ type: "proposed", proposal: p });
    return p;
  }

  private nextPrefix(): string {
    this.counter += 1;
    return `p${this.counter}-h`;
  }

  private allDecided(p: Proposal): boolean {
    return p.hunks.every((h) => p.states[h.id] !== "pending");
  }

  private answer(p: Proposal): void {
    if (p.state !== "pending") return;
    p.state = "decided";
    const accepted = p.hunks.filter((h) => p.states[h.id] === "accept" || p.states[h.id] === "accept_edit").map((h) => h.id);
    const discarded = p.hunks.filter((h) => p.states[h.id] === "reject" || p.states[h.id] === "conflict").map((h) => h.id);
    const answer = answerFor(p, accepted.length > 0);
    if (accepted.length > 0) {
      // What the buffer now holds: the radiologist's decisions applied to the base text.
      // The agent's write is `applied` iff it equals this; otherwise `partial` (buffer wins).
      const acceptedSet = new Set(accepted);
      this.grants.set(p.path, {
        toolCallId: p.toolCallId,
        path: p.path,
        expected: applyHunks(p.baseText, p.hunks, (h) => acceptedSet.has(h.id)).text,
        baseText: p.baseText,
        accepted,
        discarded,
        createdAt: Date.now(),
      });
    }
    this.waiters.get(p.toolCallId)?.(answer);
    this.waiters.delete(p.toolCallId);
    this.emit({ type: "answered", proposal: p, answer });
  }

  private emit(e: ProposalEvent): void {
    for (const fn of this.listeners) fn(e);
  }
}

/**
 * Map per-hunk decisions onto the agent's offered options: `accept_edit` if any draft-mode
 * accept and the option exists, else `accept`, else the first `allow_once`; all discarded ⇒
 * `reject` or the first `reject_once`.
 */
export function answerFor(p: Proposal, anyAccepted: boolean): PermissionAnswer {
  const options = p.options ?? [];
  const byId = (id: string) => options.find((o) => o.optionId === id);
  const byKind = (kind: string) => options.find((o) => o.kind === kind);
  if (anyAccepted) {
    const anyDraft = Object.values(p.states).includes("accept_edit");
    const pick = (anyDraft && byId("accept_edit")) || byId("accept") || byId("accept_edit") || byKind("allow_once");
    return pick ? { outcome: "selected", optionId: pick.optionId } : { outcome: "cancelled" };
  }
  const pick = byId("reject") || byKind("reject_once");
  return pick ? { outcome: "selected", optionId: pick.optionId } : { outcome: "cancelled" };
}
