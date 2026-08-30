/**
 * Audit trail (proposal §9.2). The editor is the trust boundary: it stamps every record
 * itself and sends it up the ACP connection as `_rad/audit`; the bridge persists it.
 */
import { AUDIT_METHOD, type AuditRecord, type ProfileLevel } from "acp-rad";

export type AuditContext = {
  sessionId: string;
  accession: string;
  agent: { name: string; version?: string; level: ProfileLevel };
  actor?: AuditRecord["actor"];
};

export type AuditActor = AuditRecord["actor"];
export type AuditSink = (method: string, record: AuditRecord) => void;
export type AuditFields = Partial<Pick<AuditRecord, "path" | "toolCallId" | "hunkId" | "flagId" | "flagIds" | "argsHash" | "outcome">>;

const DEFAULT_ACTOR: AuditActor = { userId: "demo-radiologist", role: "radiologist" };

export class AuditLog {
  readonly records: AuditRecord[] = [];
  private readonly listeners = new Set<(r: AuditRecord) => void>();
  private ctx: AuditContext | null = null;
  private sink: AuditSink | null = null;
  /** Set by the role toggle; independent of `ctx` because `bind` replaces `ctx` wholesale. */
  private actor: AuditActor | null = null;
  /** Records made before the session exists (editor commands run while connecting); flushed on `bind`. */
  private pending: Array<{ ts: string; event: string; fields: AuditFields; actor: AuditActor }> = [];

  bind(ctx: AuditContext, sink: AuditSink): void {
    this.ctx = ctx;
    this.sink = sink;
    const queued = this.pending;
    this.pending = [];
    for (const q of queued) this.emit(q.event, q.fields, q.ts, q.actor);
  }

  /** Who acts from now on (the role toggle); records already queued keep the actor they were made under. */
  setActor(actor: AuditActor): void {
    this.actor = actor;
  }

  subscribe(fn: (r: AuditRecord) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Stamp and emit a record; before `bind` it is queued and stamped with the session once one exists. */
  record(event: string, fields: AuditFields = {}, ts = new Date().toISOString()): void {
    this.emit(event, fields, ts, this.actor ?? this.ctx?.actor ?? DEFAULT_ACTOR);
  }

  private emit(event: string, fields: AuditFields, ts: string, actor: AuditActor): void {
    if (!this.ctx) {
      this.pending.push({ ts, event, fields, actor });
      return;
    }
    const rec: AuditRecord = {
      ts,
      sessionId: this.ctx.sessionId,
      accession: this.ctx.accession,
      actor,
      agent: this.ctx.agent,
      event,
      ...fields,
    };
    this.records.push(rec);
    for (const fn of this.listeners) fn(rec);
    try {
      this.sink?.(AUDIT_METHOD, rec);
    } catch {
      /* the local record is the source of truth; persistence is best-effort in the PoC */
    }
  }
}

/** Cheap content fingerprint for `argsHash` (not cryptographic; the PoC has no crypto requirement). */
export function fingerprint(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
