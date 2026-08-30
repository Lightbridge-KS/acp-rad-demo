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

export type AuditSink = (method: string, record: AuditRecord) => void;
export type AuditFields = Partial<Pick<AuditRecord, "path" | "toolCallId" | "hunkId" | "argsHash" | "outcome">>;

export class AuditLog {
  readonly records: AuditRecord[] = [];
  private readonly listeners = new Set<(r: AuditRecord) => void>();
  private ctx: AuditContext | null = null;
  private sink: AuditSink | null = null;
  /** Records made before the session exists (editor commands run while connecting); flushed on `bind`. */
  private pending: Array<{ ts: string; event: string; fields: AuditFields }> = [];

  bind(ctx: AuditContext, sink: AuditSink): void {
    this.ctx = ctx;
    this.sink = sink;
    const queued = this.pending;
    this.pending = [];
    for (const q of queued) this.record(q.event, q.fields, q.ts);
  }

  subscribe(fn: (r: AuditRecord) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Stamp and emit a record; before `bind` it is queued and stamped with the session once one exists. */
  record(event: string, fields: AuditFields = {}, ts = new Date().toISOString()): void {
    if (!this.ctx) {
      this.pending.push({ ts, event, fields });
      return;
    }
    const rec: AuditRecord = {
      ts,
      sessionId: this.ctx.sessionId,
      accession: this.ctx.accession,
      actor: this.ctx.actor ?? { userId: "demo-radiologist", role: "radiologist" },
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
