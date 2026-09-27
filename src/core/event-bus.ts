import { logger } from "./log";
import type { EventBus } from "./ports";
import type { CallEvent } from "./types";

const log = logger("events");

export class MemoryEventBus implements EventBus {
  private listeners = new Set<(ev: CallEvent) => void>();

  publish(ev: CallEvent) {
    for (const fn of this.listeners) {
      try {
        fn(ev);
      } catch (err) {
        log.error("event listener failed", { callId: ev.callId, type: ev.type, err });
      }
    }
  }

  subscribe(fn: (ev: CallEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
