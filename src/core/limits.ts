import type { AppConfig, ChannelLimits } from "./config";
import { ipKey } from "./ip";
import { logger } from "./log";
import type { CallRecord, Clock, Repo } from "./ports";

// Call limits per channel (config/limits.yaml), applied by CallManager.registerIncoming to every
// incoming call before anything billed starts. Counted over a rolling 24 h from the call list, so
// a restart doesn't reset them, plus the calls being set up or live here.

/** Where a call came from: the real number, an admin test call, or the public page. */
export type Channel = "phone" | "test" | "public";
export const CHANNELS: readonly Channel[] = ["phone", "test", "public"];

/**
 * Why a call was turned away: too many at once, this caller's calls for the day, the channel's
 * calls for the day, or its spend for the day.
 */
export type LimitHit = "busy" | "per_caller" | "quota" | "budget";

const log = logger("limits");
const DAY_MS = 24 * 60 * 60 * 1000;

/** The longest a call on `ch` may run: limits.yaml max_call_seconds under the call flow's. */
export function callSecondsCap(cfg: AppConfig, ch: Channel): number {
  const cap = cfg.limits[ch].max_call_seconds;
  return cap === null ? cfg.flow.timing.max_call_seconds : Math.min(cap, cfg.flow.timing.max_call_seconds);
}

/** Numbers that say nothing about who's calling: they aren't counted per caller. */
const withheld = (caller: string | undefined): caller is undefined =>
  !caller || ["anonymous", "unknown", "restricted", "private"].includes(caller.toLowerCase());

export interface Usage {
  /** calls over the last 24 h, the ones being set up or live here included */
  calls: number;
  /** calls being set up or live here */
  live: number;
  /** stored cost of the calls that ended over the last 24 h */
  spentUsd: number;
}

export class CallGate {
  /** calls admitted and not yet ended, with their channel and caller */
  private active = new Map<string, { channel: Channel; caller?: string }>();

  constructor(private d: { repo: Pick<Repo, "listCallsByChannel">; config: () => AppConfig; clock: Clock }) {}

  /** Reserves a slot for the call, or says which limit turns it away. `release` it once it has ended. */
  async admit(c: { callId: string; channel: Channel; caller?: string }): Promise<LimitHit | null> {
    const lim = this.d.config().limits[c.channel];
    if (lim.max_concurrent_calls !== null && this.live(c.channel) >= lim.max_concurrent_calls) {
      log.info("call declined: busy", { callId: c.callId, channel: c.channel, maxConcurrent: lim.max_concurrent_calls });
      return "busy";
    }
    const caller = withheld(c.caller) ? undefined : c.caller;
    // Reserved before the await, so concurrent calls see this one; undone if it's refused.
    this.active.set(c.callId, { channel: c.channel, caller });
    let admitted = false;
    try {
      const now = this.d.clock.now();
      const rows = await this.rows(c.channel, now);
      const hit = this.check(c.channel, lim, rows, now, caller, 0);
      if (hit) log.info(`call declined: ${hit}`, { callId: c.callId, channel: c.channel, spentUsd: spent(rows, now), maxUsd: lim.max_spend_usd_per_day });
      admitted = hit === null;
      return hit;
    } finally {
      if (!admitted) this.active.delete(c.callId);
    }
  }

  /** Whether a new call on `ch` would be turned away for everyone, without reserving anything. */
  async exhausted(ch: Channel): Promise<"quota" | "budget" | null> {
    const lim = this.d.config().limits[ch];
    const now = this.d.clock.now();
    const hit = this.check(ch, lim, await this.rows(ch, now), now, undefined, 1);
    return hit === "quota" || hit === "budget" ? hit : null;
  }

  async usage(ch: Channel): Promise<Usage> {
    const now = this.d.clock.now();
    const rows = await this.rows(ch, now);
    return { calls: this.calls(ch, rows, now).size, live: this.live(ch), spentUsd: spent(rows, now) };
  }

  release(callId: string) {
    this.active.delete(callId);
  }

  /**
   * The limit a call is over, counting the active calls (the one being admitted is among them)
   * plus `extra` more: 1 asks whether one more call would fit.
   */
  private check(ch: Channel, lim: ChannelLimits, rows: CallRecord[], now: number, caller: string | undefined, extra: number): LimitHit | null {
    if (caller !== undefined && lim.max_calls_per_caller_per_day !== null) {
      const v6Prefix = this.d.config().limits.ipv6_prefix;
      const ids = new Set(rows.filter((r) => r.startedAt >= now - DAY_MS && callerOf(r, v6Prefix) === caller).map((r) => r.id));
      for (const [id, a] of this.active) if (a.channel === ch && a.caller === caller) ids.add(id);
      if (ids.size > lim.max_calls_per_caller_per_day) return "per_caller";
    }
    if (lim.max_calls_per_day !== null && this.calls(ch, rows, now).size + extra > lim.max_calls_per_day) return "quota";
    // The call that crosses it runs to its end; the next one is turned away.
    if (lim.max_spend_usd_per_day !== null && spent(rows, now) >= lim.max_spend_usd_per_day) return "budget";
    return null;
  }

  private async rows(ch: Channel, now: number) {
    return (await this.d.repo.listCallsByChannel(ch, now - DAY_MS)).filter((r) => r.declined === null);
  }

  /** the day's calls: stored ones and active ones not stored yet */
  private calls(ch: Channel, rows: CallRecord[], now: number) {
    const ids = new Set(rows.filter((r) => r.startedAt >= now - DAY_MS).map((r) => r.id));
    for (const [id, a] of this.active) if (a.channel === ch) ids.add(id);
    return ids;
  }

  private live(ch: Channel) {
    let n = 0;
    for (const a of this.active.values()) if (a.channel === ch) n++;
    return n;
  }
}

/** the caller a stored call is counted for: the client IP's key (ipKey) on the public page, else the number */
const callerOf = (r: CallRecord, v6Prefix: number) => (r.channel === "public" ? ipKey(r.callerIp ?? "local", v6Prefix) : r.from);

function spent(rows: CallRecord[], now: number): number {
  return rows.reduce((sum, r) => sum + (r.status === "ended" && (r.endedAt ?? 0) >= now - DAY_MS ? (r.costUsd ?? 0) : 0), 0);
}
