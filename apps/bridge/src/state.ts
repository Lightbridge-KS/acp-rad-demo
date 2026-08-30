import { Redis } from "@upstash/redis";

export type SharedState = {
  ping(): Promise<void>;
  acquireLease(member: string, nowMs: number, ttlMs: number, limit: number): Promise<boolean>;
  renewLease(member: string, nowMs: number, ttlMs: number): Promise<"renewed" | "missing">;
  releaseLease(member: string): Promise<void>;
  appendAudit(accession: string, record: unknown, retentionSeconds: number): Promise<void>;
};

const ACQUIRE_LEASE = `
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", ARGV[1])
if redis.call("ZCARD", KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
redis.call("ZADD", KEYS[1], ARGV[2], ARGV[4])
return 1
`;

const RENEW_LEASE = `
local expires = redis.call("ZSCORE", KEYS[1], ARGV[3])
if expires == false or tonumber(expires) <= tonumber(ARGV[1]) then
  redis.call("ZREM", KEYS[1], ARGV[3])
  return 0
end
redis.call("ZADD", KEYS[1], ARGV[2], ARGV[3])
return 1
`;

const APPEND_AUDIT = `
redis.call("RPUSH", KEYS[1], ARGV[1])
redis.call("EXPIRE", KEYS[1], ARGV[2])
return 1
`;

export class UpstashState implements SharedState {
  private readonly redis: Redis;
  private readonly prefix: string;

  constructor(url: string, token: string, environment: string) {
    this.redis = new Redis({ url, token });
    this.prefix = `acp-rad:${environment}`;
  }

  async ping(): Promise<void> {
    await this.redis.ping();
  }

  async acquireLease(member: string, nowMs: number, ttlMs: number, limit: number): Promise<boolean> {
    const result = await this.redis.eval(ACQUIRE_LEASE, [`${this.prefix}:leases`], [nowMs, nowMs + ttlMs, limit, member]);
    return Number(result) === 1;
  }

  async renewLease(member: string, nowMs: number, ttlMs: number): Promise<"renewed" | "missing"> {
    const result = Number(await this.redis.eval(RENEW_LEASE, [`${this.prefix}:leases`], [nowMs, nowMs + ttlMs, member]));
    return result === 1 ? "renewed" : "missing";
  }

  async releaseLease(member: string): Promise<void> {
    await this.redis.zrem(`${this.prefix}:leases`, member);
  }

  async appendAudit(accession: string, record: unknown, retentionSeconds: number): Promise<void> {
    const safe = accession.replace(/[^A-Za-z0-9_-]/g, "_");
    await this.redis.eval(APPEND_AUDIT, [`${this.prefix}:audit:${safe}`], [JSON.stringify(record), retentionSeconds]);
  }
}

type Lease = { expiresAt: number };

/** One-process implementation for local Compose and deterministic tests. */
export class MemoryState implements SharedState {
  readonly audits = new Map<string, unknown[]>();
  private readonly leases = new Map<string, Lease>();

  async ping(): Promise<void> {}

  async acquireLease(member: string, nowMs: number, ttlMs: number, limit: number): Promise<boolean> {
    this.prune(nowMs);
    if (this.leases.size >= limit) return false;
    this.leases.set(member, { expiresAt: nowMs + ttlMs });
    return true;
  }

  async renewLease(member: string, nowMs: number, ttlMs: number): Promise<"renewed" | "missing"> {
    this.prune(nowMs);
    if (!this.leases.has(member)) return "missing";
    this.leases.set(member, { expiresAt: nowMs + ttlMs });
    return "renewed";
  }

  async releaseLease(member: string): Promise<void> {
    this.leases.delete(member);
  }

  async appendAudit(accession: string, record: unknown, _retentionSeconds: number): Promise<void> {
    this.audits.set(accession, [...(this.audits.get(accession) ?? []), record]);
  }

  private prune(nowMs: number): void {
    for (const [member, lease] of this.leases) if (lease.expiresAt <= nowMs) this.leases.delete(member);
  }
}
