import type { EventBus } from "./ports";
import type { CallEvent } from "./types";

export class MemoryEventBus implements EventBus {
  private listeners = new Set<(ev: CallEvent) => void>();

  publish(ev: CallEvent) {
    for (const fn of this.listeners) {
      try {
        fn(ev);
      } catch (err) {
        console.error("event listener failed", err);
      }
    }
  }

  subscribe(fn: (ev: CallEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
