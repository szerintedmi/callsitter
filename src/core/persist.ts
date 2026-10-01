import { logger } from "./log";
import type { CallRecord, EventBus, Repo } from "./ports";
import type { CallEvent } from "./types";

const log = logger("persist");

export interface Persistence {
  /** resolves once every event published so far is stored */
  flush(): Promise<void>;
  detach(): void;
}

/**
 * Persists call events and keeps the call row up to date (each event and its change to the row
 * in one transaction). Transcript deltas are pushed to the UI but only final utterances are
 * stored. Writes are serialised to keep event order.
 */
export function attachPersistence(bus: EventBus, repo: Repo): Persistence {
  let chain = Promise.resolve();
  const detach = bus.subscribe((ev: CallEvent) => {
    if (ev.type === "transcript" && !ev.entry.final) return;
    chain = chain
      .then(() => repo.appendEvent(ev, projection(ev)))
      .catch((err) => log.error("persist failed", { callId: ev.callId, type: ev.type, err }));
  });
  return { flush: () => chain, detach };
}

/** What an event changes on its call row. */
function projection(ev: CallEvent): Partial<Omit<CallRecord, "id">> | undefined {
  switch (ev.type) {
    case "classification":
      return { verdict: ev.classification.verdict };
    case "stage":
      return { stage: ev.stage };
    case "call.ended":
      return { status: "ended", endedAt: ev.endedAt, endReason: ev.reason, lunaCalls: ev.lunaCalls, costUsd: ev.costs?.totalUsd ?? ev.costUsd, costs: ev.costs ?? null };
    case "summary":
      return { summary: ev.text };
    case "costs":
      return { costUsd: ev.costs.totalUsd, costs: ev.costs, lunaCalls: ev.costs.luna.calls };
    case "recording":
      return { recordingPath: ev.path };
  }
  return undefined;
}
