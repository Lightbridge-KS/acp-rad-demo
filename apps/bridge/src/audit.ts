import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { SharedState } from "./state.ts";

const AUDIT_METHOD = "_rad/audit";

type AuditMessage = { method?: string; params?: { accession?: string } };

export type AuditWriter = { persist(frame: string): Promise<boolean> };

export function createAuditWriter(state: SharedState | null, auditDir: string, retentionSeconds: number, log: (message: string) => void): AuditWriter {
  return {
    async persist(frame: string): Promise<boolean> {
      let message: AuditMessage;
      try {
        message = JSON.parse(frame) as AuditMessage;
      } catch {
        return false;
      }
      if (message.method !== AUDIT_METHOD) return false;
      const accession = (message.params?.accession ?? "unknown").replace(/[^A-Za-z0-9_-]/g, "_");
      try {
        if (state) await state.appendAudit(accession, message.params, retentionSeconds);
        else {
          await mkdir(auditDir, { recursive: true });
          await appendFile(path.join(auditDir, `${accession}.jsonl`), `${JSON.stringify(message.params)}\n`);
        }
      } catch (error) {
        log(`audit append failed: ${(error as Error).message}`);
      }
      return true;
    },
  };
}
