import { describe, expect, test } from "bun:test";
import type { CallManager } from "../src/core/call-manager";
import { controlRoutes } from "../src/web/control";

describe("control API", () => {
  test("drain with a TTL, status, resume", async () => {
    let drainedMs: number | null = null;
    const manager = {
      get accepting() {
        return drainedMs === null;
      },
      activeCalls: 2,
      drain: (ms: number) => void (drainedMs = ms),
      resume: () => void (drainedMs = null),
    } as unknown as CallManager;
    const app = controlRoutes(manager);
    expect(await (await app.request("/status")).json()).toEqual({ accepting: true, activeCalls: 2 });
    expect(await (await app.request("/drain?ttl=30", { method: "POST" })).json()).toEqual({ accepting: false, activeCalls: 2 });
    expect(drainedMs as number | null).toBe(30_000);
    expect((await app.request("/drain?ttl=-1", { method: "POST" })).status).toBe(400);
    expect(await (await app.request("/resume", { method: "POST" })).json()).toEqual({ accepting: true, activeCalls: 2 });
  });
});
