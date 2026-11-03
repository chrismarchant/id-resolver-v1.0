/**
 * In-memory fakes for the persistence contracts (src/contracts/db.ts).
 * Every mutating method performs its read-check-write synchronously after a
 * single microtask yield, so it is atomic with respect to other in-process
 * callers, mirroring the single-statement guarantees of the PostgreSQL code.
 */
import { randomUUID } from "node:crypto";
import type {
  ActivityRepository,
  CacheCompany,
  CacheKey,
  CacheRepository,
  CacheRow,
  CacheStatus,
  CommitOutcome,
  CommitResult,
  CompanyRepository,
  ControlsRepository,
  ProviderAttemptReservation,
  RecordObservationInput,
  RecordObservationResult,
  ReservationResult,
  UsageCounter,
  UsageRepository,
  UsageScope,
  UsageSnapshot,
} from "../../src/contracts/db.js";
import { USAGE_COUNTERS } from "../../src/contracts/db.js";

export type Clock = () => Date;
const realClock: Clock = () => new Date();

export interface FakeCacheEntry {
  status: CacheStatus;
  company: CacheCompany | null;
  /** Durable company id linked by a fenced commit (mirrors companies.id). */
  companyId: number | null;
  checkedAt: Date | null;
  expiresAt: Date;
  leaseExpiresAt: Date | null;
  token: string | null;
}

export function cacheKeyString(key: CacheKey): string {
  return `${key.installationId}|${key.websiteId}|${key.keyVersion}|${key.ipFingerprint.toString("hex")}`;
}

/** Failure injection: methods named here throw. */
type Failures<M extends string> = Partial<Record<M, boolean>>;

function failIf<M extends string>(failures: Failures<M>, method: M): void {
  if (failures[method]) throw new Error(`injected failure: ${method}`);
}

export class FakeCacheRepository implements CacheRepository {
  readonly entries = new Map<string, FakeCacheEntry>();
  readonly calls = { readFresh: 0, reserve: 0, commit: 0, release: 0, pruneExpired: 0 };
  failures: Failures<"readFresh" | "reserve" | "commit" | "release" | "pruneExpired"> = {};
  /** The fenced commit's own company registry (domain -> stable id), like the SQL commit's upsert. */
  readonly companyIds = new Map<string, number>();
  private nextCompanyId = 1;

  constructor(private readonly clock: Clock = realClock) {}

  private freshRow(e: FakeCacheEntry | undefined, now: Date): CacheRow | null {
    if (!e || e.status === "pending" || e.checkedAt === null || e.expiresAt <= now) return null;
    return { status: e.status, company: e.company ? { ...e.company } : null, companyId: e.companyId, checkedAt: e.checkedAt, expiresAt: e.expiresAt };
  }

  inspect(key: CacheKey): FakeCacheEntry | undefined {
    return this.entries.get(cacheKeyString(key));
  }

  companyIdFor(domain: string): number {
    let id = this.companyIds.get(domain);
    if (id === undefined) {
      id = this.nextCompanyId++;
      this.companyIds.set(domain, id);
    }
    return id;
  }

  /** Seed a completed row directly (test setup). */
  seed(key: CacheKey, row: Omit<CacheRow, "expiresAt" | "companyId"> & { ttlMs: number; companyId?: number | null }): void {
    const companyId = row.companyId !== undefined ? row.companyId : row.company ? this.companyIdFor(row.company.domain) : null;
    this.entries.set(cacheKeyString(key), {
      status: row.status,
      company: row.company,
      companyId,
      checkedAt: row.checkedAt,
      expiresAt: new Date(row.checkedAt.getTime() + row.ttlMs),
      leaseExpiresAt: null,
      token: null,
    });
  }

  /** The fake's clock plays the database clock: every liveness decision is made here, never from a caller timestamp. */
  async readFresh(key: CacheKey): Promise<CacheRow | null> {
    await Promise.resolve();
    this.calls.readFresh++;
    failIf(this.failures, "readFresh");
    return this.freshRow(this.entries.get(cacheKeyString(key)), this.clock());
  }

  async reserve(key: CacheKey, opts: { leaseMs: number }): Promise<ReservationResult> {
    await Promise.resolve();
    this.calls.reserve++;
    failIf(this.failures, "reserve");
    const k = cacheKeyString(key);
    const e = this.entries.get(k);
    const now = this.clock();
    const fresh = this.freshRow(e, now);
    if (fresh) return { kind: "fresh", row: fresh };
    if (e && e.status === "pending" && e.leaseExpiresAt && e.leaseExpiresAt > now) {
      return { kind: "pending", leaseExpiresAt: e.leaseExpiresAt, leaseRemainingMs: e.leaseExpiresAt.getTime() - now.getTime() };
    }
    const token = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + opts.leaseMs);
    this.entries.set(k, { status: "pending", company: null, companyId: null, checkedAt: null, expiresAt: leaseExpiresAt, leaseExpiresAt, token });
    return { kind: "acquired", token, leaseExpiresAt, leaseRemainingMs: opts.leaseMs };
  }

  async commitResolved(key: CacheKey, token: string, outcome: CommitOutcome): Promise<CommitResult> {
    await Promise.resolve();
    this.calls.commit++;
    failIf(this.failures, "commit");
    const k = cacheKeyString(key);
    const e = this.entries.get(k);
    const now = this.clock();
    if (!e || e.status !== "pending" || e.token !== token || !e.leaseExpiresAt || e.leaseExpiresAt <= now) return { kind: "lost_lease" };
    const companyId = outcome.company ? this.companyIdFor(outcome.company.domain) : null;
    this.entries.set(k, {
      status: outcome.status,
      company: outcome.company ? { ...outcome.company } : null,
      companyId,
      checkedAt: outcome.checkedAt,
      expiresAt: new Date(now.getTime() + outcome.ttlMs), // database time + ttl, like FENCED_WRITE_SQL
      leaseExpiresAt: null,
      token: null,
    });
    return { kind: "committed", companyId };
  }

  async commit(key: CacheKey, token: string, outcome: CommitOutcome): Promise<"committed" | "lost_lease"> {
    return (await this.commitResolved(key, token, outcome)).kind;
  }

  async release(key: CacheKey, token: string): Promise<void> {
    await Promise.resolve();
    this.calls.release++;
    failIf(this.failures, "release");
    const e = this.entries.get(cacheKeyString(key));
    if (!e || e.status !== "pending" || e.token !== token) return;
    e.token = null;
    e.leaseExpiresAt = null;
    e.expiresAt = new Date(0);
  }

  async pruneExpired(limit: number): Promise<number> {
    await Promise.resolve();
    this.calls.pruneExpired++;
    failIf(this.failures, "pruneExpired");
    let n = 0;
    for (const [k, e] of this.entries) {
      if (n >= limit) break;
      const leaseLive = e.leaseExpiresAt !== null && e.leaseExpiresAt > now;
      if (e.expiresAt <= now && !leaseLive) {
        this.entries.delete(k);
        n++;
      }
    }
    return n;
  }

  /** Test helper: simulate lease expiry/takeover by another worker. */
  expireLease(key: CacheKey): void {
    const e = this.entries.get(cacheKeyString(key));
    if (e) {
      e.leaseExpiresAt = new Date(0);
      e.token = randomUUID();
    }
  }
}

export class FakeControlsRepository implements ControlsRepository {
  readonly enabled = new Map<string, boolean>();
  failures: Failures<"isEnrichmentEnabled" | "setEnrichmentEnabled"> = {};

  async isEnrichmentEnabled(installationId: string): Promise<boolean> {
    await Promise.resolve();
    failIf(this.failures, "isEnrichmentEnabled");
    return this.enabled.get(installationId) ?? true;
  }

  async setEnrichmentEnabled(installationId: string, enabled: boolean, _reason: string): Promise<void> {
    await Promise.resolve();
    failIf(this.failures, "setEnrichmentEnabled");
    this.enabled.set(installationId, enabled);
  }
}

type Period = Record<UsageCounter, number> & { providerCreditsReported: number; providerCreditsEstimated: number };

export class FakeUsageRepository implements UsageRepository {
  readonly periods = new Map<string, Period>();
  failures: Failures<"reserveProviderAttempt" | "increment" | "addProviderCredits" | "snapshot"> = {};
  /** Delay applied to best-effort accounting (increment, addProviderCredits) only; the attempt reservation is never delayed. */
  accountingDelayMs = 0;

  constructor(private readonly controls: FakeControlsRepository = new FakeControlsRepository()) {}

  private period(scope: UsageScope): Period {
    const k = `${scope.installationId}|${scope.websiteId}|${scope.periodKey}`;
    let p = this.periods.get(k);
    if (!p) {
      p = { providerCreditsReported: 0, providerCreditsEstimated: 0 } as Period;
      for (const c of USAGE_COUNTERS) p[c] = 0;
      this.periods.set(k, p);
    }
    return p;
  }

  async reserveProviderAttempt(scope: UsageScope, cap: number): Promise<ProviderAttemptReservation> {
    await Promise.resolve();
    failIf(this.failures, "reserveProviderAttempt");
    if (this.controls.enabled.get(scope.installationId) === false) return "disabled";
    const p = this.period(scope);
    if (p.provider_attempts >= cap) return "cap_exhausted";
    p.provider_attempts++;
    return "reserved";
  }

  async increment(scope: UsageScope, counter: UsageCounter, delta = 1): Promise<void> {
    await Promise.resolve();
    failIf(this.failures, "increment");
    if (this.accountingDelayMs > 0) await new Promise((r) => setTimeout(r, this.accountingDelayMs));
    this.period(scope)[counter] += delta;
  }

  async addProviderCredits(scope: UsageScope, credits: { reported?: number; estimated?: number }): Promise<void> {
    await Promise.resolve();
    failIf(this.failures, "addProviderCredits");
    if (this.accountingDelayMs > 0) await new Promise((r) => setTimeout(r, this.accountingDelayMs));
    const p = this.period(scope);
    p.providerCreditsReported += credits.reported ?? 0;
    p.providerCreditsEstimated += credits.estimated ?? 0;
  }

  async snapshot(scope: UsageScope): Promise<UsageSnapshot> {
    await Promise.resolve();
    failIf(this.failures, "snapshot");
    return { ...this.period(scope), periodKey: scope.periodKey };
  }
}

export class FakeCompanyRepository implements CompanyRepository {
  readonly companies = new Map<string, { id: number; organisationName: string | null; firstSeenAt: Date; lastSeenAt: Date }>();
  failures: Failures<"upsert"> = {};
  private nextId = 1;

  async upsert(company: { domain: string; organisationName: string | null }, now: Date): Promise<number> {
    await Promise.resolve();
    failIf(this.failures, "upsert");
    const existing = this.companies.get(company.domain);
    if (existing) {
      existing.organisationName = company.organisationName ?? existing.organisationName;
      existing.lastSeenAt = now;
      return existing.id;
    }
    const id = this.nextId++;
    this.companies.set(company.domain, { id, organisationName: company.organisationName, firstSeenAt: now, lastSeenAt: now });
    return id;
  }
}

export interface FakeObservation {
  id: number;
  installationId: string;
  websiteId: string;
  companyId: number;
  observedAt: Date;
  observationRef: string;
  source: "cache" | "provider";
  companyFirst: boolean;
}

/**
 * In-memory activity store with the SQL semantics: one observation per
 * (scope, ref); "previously seen" decided against committed state before the
 * insert; nothing changes on a duplicate. `delayMs` lets tests exercise the
 * deadline bound.
 */
export interface FakeObservationRef {
  installationId: string;
  websiteId: string;
  observationRef: string;
  companyId: number;
  previouslySeen: boolean;
}

export class FakeActivityRepository implements ActivityRepository {
  readonly observations: FakeObservation[] = [];
  /** Deduplication records: survive pruning, like company_observation_refs. */
  readonly refs: FakeObservationRef[] = [];
  readonly calls = { recordObservation: 0, pruneObservationsBefore: 0 };
  failures: Failures<"recordObservation" | "pruneObservationsBefore"> = {};
  delayMs = 0;
  private nextId = 1;

  private seen(scope: { installationId: string; websiteId: string }, companyId: number): boolean {
    return this.refs.some((r) => r.installationId === scope.installationId && r.websiteId === scope.websiteId && r.companyId === companyId);
  }

  async recordObservation(input: RecordObservationInput): Promise<RecordObservationResult> {
    await Promise.resolve();
    this.calls.recordObservation++;
    failIf(this.failures, "recordObservation");
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    const existing = this.refs.find(
      (r) => r.installationId === input.scope.installationId && r.websiteId === input.scope.websiteId && r.observationRef === input.observationRef,
    );
    if (existing) {
      const row = this.observations.find((o) => o.installationId === existing.installationId && o.websiteId === existing.websiteId && o.observationRef === existing.observationRef);
      return { kind: "duplicate", observationId: row ? row.id : null, previouslySeen: existing.previouslySeen, sameCompany: existing.companyId === input.companyId };
    }
    const previouslySeen = this.seen(input.scope, input.companyId);
    const id = this.nextId++;
    this.refs.push({ installationId: input.scope.installationId, websiteId: input.scope.websiteId, observationRef: input.observationRef, companyId: input.companyId, previouslySeen });
    this.observations.push({
      id,
      installationId: input.scope.installationId,
      websiteId: input.scope.websiteId,
      companyId: input.companyId,
      observedAt: input.observedAt,
      observationRef: input.observationRef,
      source: input.source,
      companyFirst: !previouslySeen,
    });
    return { kind: "recorded", observationId: id, previouslySeen };
  }

  async pruneObservationsBefore(cutoff: Date, limit: number): Promise<number> {
    await Promise.resolve();
    this.calls.pruneObservationsBefore++;
    failIf(this.failures, "pruneObservationsBefore");
    let n = 0;
    for (let i = this.observations.length - 1; i >= 0 && n < limit; i--) {
      if (this.observations[i]!.observedAt < cutoff) {
        this.observations.splice(i, 1);
        n++;
      }
    }
    return n;
  }
}

export function createFakeRepositories(clock: Clock = realClock) {
  const controls = new FakeControlsRepository();
  return {
    cache: new FakeCacheRepository(clock),
    usage: new FakeUsageRepository(controls),
    controls,
    companies: new FakeCompanyRepository(),
    activity: new FakeActivityRepository(),
  };
}
