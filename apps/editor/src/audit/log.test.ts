/**
 * The audit log stamps context the Client can attest. `agent.version` alone stopped identifying
 * what produced a turn once three parties could change it — the agent author ships the base
 * skills, the institution and the radiologist layer over them, and the model is chosen per
 * session. These tests pin what each record must carry.
 */
import { describe, expect, it } from "vitest";
import { AuditLog, fingerprint } from "./log.ts";

const CTX = {
  sessionId: "s1",
  accession: "ACC1",
  agent: { name: "rad-report-agent", version: "0.1.0", level: 1 as const },
};

const sink = () => {
  const sent: unknown[] = [];
  return { sent, fn: (_m: string, r: unknown) => sent.push(r) };
};

describe("AuditLog model provenance", () => {
  it("stamps every record with the model in force", () => {
    const log = new AuditLog();
    log.bind(CTX, sink().fn);
    log.setModel("openai:gpt-5.6-terra");
    log.record("fs.read", { path: "/worklist/ACC1/report.md" });
    expect(log.records[0]!.model).toBe("openai:gpt-5.6-terra");
  });

  it("follows a mid-session switch — records name the model that did the work", () => {
    // The reason this is not part of `bind`'s context: `ctx` is bound once at connect, but
    // `session/set_config_option` can change the model at any point in the session.
    const log = new AuditLog();
    log.bind(CTX, sink().fn);
    log.setModel("openai:gpt-5.6-terra");
    log.record("command.impression");
    log.setModel("anthropic:claude-sonnet-5");
    log.record("command.impression");
    expect(log.records.map((r) => r.model)).toEqual(["openai:gpt-5.6-terra", "anthropic:claude-sonnet-5"]);
  });

  it("omits the field entirely when no model is known", () => {
    const log = new AuditLog();
    log.bind(CTX, sink().fn);
    log.record("session.new");
    expect(log.records[0]!.model).toBeUndefined();
    expect("model" in log.records[0]!).toBe(false);
  });

  it("records the switch itself alongside the model that was still in force", () => {
    // `session.config` is emitted before the new model takes effect, so the record reads
    // "was X, switching to Y" — both halves of the transition are on one line.
    const log = new AuditLog();
    log.bind(CTX, sink().fn);
    log.setModel("openai:gpt-5.6-terra");
    log.record("session.config", { outcome: "model=anthropic:claude-sonnet-5" });
    expect(log.records[0]!.model).toBe("openai:gpt-5.6-terra");
    expect(log.records[0]!.outcome).toBe("model=anthropic:claude-sonnet-5");
  });
});

describe("AuditLog skill provenance", () => {
  it("carries the skill and the client-served layers behind it", () => {
    const log = new AuditLog();
    const s = sink();
    log.bind(CTX, s.fn);
    log.record("skill.mentioned", { skill: "qa", skillLayers: ["house", "personal"], argsHash: fingerprint("a\nb") });
    const rec = log.records[0]!;
    expect(rec.skill).toBe("qa");
    expect(rec.skillLayers).toEqual(["house", "personal"]);
    expect(rec.argsHash).toBe(fingerprint("a\nb"));
    expect(s.sent).toHaveLength(1); // and it reaches the sink for persistence
  });

  it("distinguishes two turns whose layers differ", () => {
    // A radiologist with a personal /qa layer and one without must not produce records that
    // read the same: the whole point is that the audit can tell which instructions ran.
    expect(fingerprint("base\nhouse")).not.toBe(fingerprint("base\nhouse\npersonal"));
  });

  it("queues before bind and keeps its fields", () => {
    const log = new AuditLog();
    log.record("skill.mentioned", { skill: "impression" });
    expect(log.records).toHaveLength(0);
    log.bind(CTX, sink().fn);
    expect(log.records[0]!.skill).toBe("impression");
  });
});
