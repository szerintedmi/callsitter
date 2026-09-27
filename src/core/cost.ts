import type { CostConfig } from "./config";
import type { CallCosts, PricedUsage, TokenUsage } from "./types";

// Per-call cost from what the vendors report: Live's session seconds, Luna's tokens, Jev's input
// tokens, priced with cost.yaml, plus the carrier's own bill for the phone leg.

/** Luna's cost for one call's tokens (input_tokens includes cached tokens and cache writes). */
export function priceLuna(u: TokenUsage, cost: CostConfig): PricedUsage {
  const p = cost.luna;
  const uncached = Math.max(0, u.inputTokens - u.cachedTokens - u.cacheWriteTokens);
  const usd =
    (uncached * p.input_usd_per_mtok +
      u.cachedTokens * p.cached_input_usd_per_mtok +
      u.cacheWriteTokens * p.cache_write_usd_per_mtok +
      u.outputTokens * p.output_usd_per_mtok) /
    1e6;
  const tier = u.serviceTier ? (p.tier_multipliers[u.serviceTier] ?? 1) : 1;
  return { ...u, costUsd: usd * tier };
}

/** Sums a call's costs as they come in. */
export class CostMeter {
  private luna = { calls: 0, inputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  private lunaUsd = 0;
  jevInputTokens = 0;
  /** set, not added: the carrier may deliver its bill more than once */
  carrierUsd: number | undefined;

  constructor(private cost: () => CostConfig) {}

  /** Prices one Luna call and adds it. */
  addLuna(u: TokenUsage): PricedUsage {
    const priced = priceLuna(u, this.cost());
    this.luna.calls++;
    this.luna.inputTokens += u.inputTokens;
    this.luna.cachedTokens += u.cachedTokens;
    this.luna.cacheWriteTokens += u.cacheWriteTokens;
    this.luna.outputTokens += u.outputTokens;
    this.luna.reasoningTokens += u.reasoningTokens;
    this.lunaUsd += priced.costUsd;
    return priced;
  }

  /** The call's costs, with Live billed for `liveSeconds`. */
  total(liveSeconds: number): CallCosts {
    const c = this.cost();
    const liveUsd = (liveSeconds / 60) * c.live_usd_per_min;
    const jevUsd = (this.jevInputTokens / 1e6) * c.jev_usd_per_mtok;
    const costs: CallCosts = {
      liveSeconds: Math.round(liveSeconds),
      liveUsd: round(liveUsd),
      lunaUsd: round(this.lunaUsd),
      jevUsd: round(jevUsd),
      totalUsd: round(liveUsd + this.lunaUsd + jevUsd),
      luna: { ...this.luna },
      jevInputTokens: this.jevInputTokens,
    };
    return this.carrierUsd === undefined ? costs : withCarrier(costs, this.carrierUsd);
  }
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** `c` with the carrier's bill in (replacing any earlier one). */
export function withCarrier(c: CallCosts, carrierUsd: number): CallCosts {
  return { ...c, carrierUsd: round(carrierUsd), totalUsd: round(c.liveUsd + c.lunaUsd + c.jevUsd + carrierUsd) };
}

/** Luna's tokens: "1200 in (800 cached) / 300 out (100 reasoning) tokens" */
export function describeLunaTokens(u: { inputTokens: number; cachedTokens: number; cacheWriteTokens: number; outputTokens: number; reasoningTokens: number }): string {
  const cached = `${u.cachedTokens} cached${u.cacheWriteTokens ? `, ${u.cacheWriteTokens} cache writes` : ""}`;
  return `${u.inputTokens} in (${cached}) / ${u.outputTokens} out (${u.reasoningTokens} reasoning) tokens`;
}

/** "$0.123 (Live $0.100 · Luna $0.021 · Jev $0.002 · carrier $0.023)" */
export function describeCosts(c: CallCosts): string {
  const carrier = c.carrierUsd !== undefined ? ` · carrier $${c.carrierUsd.toFixed(3)}` : "";
  return `$${c.totalUsd.toFixed(3)} (Live $${c.liveUsd.toFixed(3)} · Luna $${c.lunaUsd.toFixed(3)} · Jev $${c.jevUsd.toFixed(3)}${carrier})`;
}
