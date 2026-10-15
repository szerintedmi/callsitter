import { describe, expect, test } from "bun:test";
import { openSqlite, SqliteRepo } from "../src/adapters/storage/sqlite";
import { CallManager, NO_MEDIA } from "../src/core/call-manager";
import { MemoryEventBus } from "../src/core/event-bus";
import { attachPersistence } from "../src/core/persist";
import type { Agent } from "../src/core/ports";
import { loadRepoConfig, scripted } from "./helpers";

async function rig(agent: Agent = { run: async () => ({ toolCalls: [] }), summarize: async () => ({ text: "" }) }) {
  const config = await loadRepoConfig();
  const repo = new SqliteRepo(openSqlite(":memory:"));
  const bus = new MemoryEventBus();
  const persistence = attachPersistence(bus, repo);
  let connects = 0;
  const manager = new CallManager({
    config: () => config,
    voice: {
      async connect() {
        connects++;
        return { sendAudio() {}, append() {}, async close() {} };
      },
    },
    classifier: scripted({ verdict: "unclear", confidence: 0.5 }),
    agent,
    bus,
    telephony: { hangup: async () => {} },
    clock: { now: () => Date.now() },
    repo,
    blobs: { put: async (k) => k, get: async () => null },
  });
  await manager.registerIncoming({ callId: "c1", callControlId: "cc1", from: "+441", to: "+442", channel: "phone" });
  return { manager, repo, persistence, config, connects: () => connects };
}

describe("call manager", () => {
  test("concurrent attaches for one call share one session", async () => {
    const r = await rig();
    const [a, b] = await Promise.all([r.manager.attachMedia("c1", NO_MEDIA, "pcma"), r.manager.attachMedia("c1", NO_MEDIA, "pcma")]);
    expect(a).toBe(b);
    expect(r.connects()).toBe(1);
    await a.stop("test");
    expect(r.manager.get("c1")).toBeUndefined();
  });

  test("shutdown waits for the wrap-up of a call that ended just before", async () => {
    let release!: () => void;
    const r = await rig({
      run: async () => ({ toolCalls: [] }),
      summarize: async () => (await new Promise<void>((res) => (release = res)), { text: "Sarah called about dinner." }),
    });
    const s = await r.manager.attachMedia("c1", NO_MEDIA, "pcma");
    s.orch.onTranscriptDelta("caller", "u1", "It's Sarah.");
    void s.stop("caller hung up");
    while (r.manager.get("c1")) await Bun.sleep(1); // out of the registry; the summary is still running
    let done = false;
    const all = r.manager.stopAll("server shutting down").then(() => (done = true));
    await Bun.sleep(10);
    expect(done).toBe(false);
    release();
    await all;
    await r.persistence.flush();
    const call = await r.repo.getCall("c1");
    expect(call?.status).toBe("ended");
    expect(call?.summary).toBe("Sarah called about dinner.");
  });

  test("the carrier's bill, arriving during the wrap-up, stays in the final costs", async () => {
    let release!: () => void;
    const usage = { model: "gpt-6-luna", inputTokens: 1_000_000, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
    const r = await rig({
      run: async () => ({ toolCalls: [] }),
      summarize: async () => (await new Promise<void>((res) => (release = res)), { text: "Sarah called.", usage }),
    });
    const s = await r.manager.attachMedia("c1", NO_MEDIA, "pcma");
    s.orch.onTranscriptDelta("caller", "u1", "It's Sarah.");
    void s.stop("caller hung up");
    while (r.manager.get("c1")) await Bun.sleep(1); // ended; the summary is still running
    await r.manager.carrierCost("c1", 0.02);
    await r.persistence.flush();
    expect((await r.repo.getCall("c1"))?.costs?.carrierUsd).toBe(0.02);
    release();
    await s.finished;
    await r.persistence.flush();
    // The summary's costs event (Luna priced in) still has the carrier's bill.
    const costs = (await r.repo.getCall("c1"))!.costs!;
    expect(costs.lunaUsd).toBeGreaterThan(0);
    expect(costs).toMatchObject({ carrierUsd: 0.02 });
    expect(costs.totalUsd).toBeCloseTo(costs.liveUsd + costs.lunaUsd + costs.jevUsd + 0.02, 6);
  });

  test("the carrier's bill, arriving just after the wrap-up, keeps the summary's cost", async () => {
    const usage = { model: "gpt-6-luna", inputTokens: 1_000_000, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
    const r = await rig({ run: async () => ({ toolCalls: [] }), summarize: async () => ({ text: "Sarah called.", usage }) });
    const s = await r.manager.attachMedia("c1", NO_MEDIA, "pcma");
    s.orch.onTranscriptDelta("caller", "u1", "It's Sarah.");
    await s.stop("caller hung up");
    await s.finished;
    // Before persistence has stored the summary's costs.
    await r.manager.carrierCost("c1", 0.02);
    await r.persistence.flush();
    const costs = (await r.repo.getCall("c1"))!.costs!;
    expect(costs.lunaUsd).toBeGreaterThan(0);
    expect(costs.totalUsd).toBeCloseTo(costs.liveUsd + costs.lunaUsd + costs.jevUsd + 0.02, 6);
  });

  test("no new session starts once shutdown has begun", async () => {
    const r = await rig();
    const attach = r.manager.attachMedia("c1", NO_MEDIA, "pcma"); // still reading the call record
    await r.manager.stopAll("server shutting down");
    await expect(attach).rejects.toThrow("server shutting down");
    expect(r.connects()).toBe(0);
  });

  test("drain turns new calls away until resumed or its TTL runs out, and counts calls until they end", async () => {
    const r = await rig();
    expect(r.manager.activeCalls).toBe(1); // c1: registered, media not connected yet
    r.manager.drain(60_000);
    expect(r.manager.accepting).toBe(false);
    await expect(r.manager.registerIncoming({ callId: "c2", callControlId: "cc2", from: "+441", to: "+442", channel: "phone" })).rejects.toThrow(
      "not accepting calls",
    );
    expect(await r.repo.getCall("c2")).toBeNull();
    await r.manager.attachMedia("c1", NO_MEDIA, "pcma");
    expect(r.manager.activeCalls).toBe(1);
    await r.manager.hangup("c1", "caller hung up");
    expect(r.manager.activeCalls).toBe(0);
    r.manager.resume();
    expect(r.manager.accepting).toBe(true);
    r.manager.drain(20);
    await Bun.sleep(40);
    expect(r.manager.accepting).toBe(true);
  });

  test("a call over its channel's limits isn't registered, and the slot is free again once a call ends", async () => {
    const r = await rig();
    r.config.limits.phone.max_concurrent_calls = 1;
    const c2 = { callId: "c2", callControlId: "cc2", from: "+443", to: "+442", channel: "phone" as const };
    expect(await r.manager.registerIncoming(c2)).toBe("busy");
    expect(r.manager.activeCalls).toBe(1);
    expect(await r.repo.getCall("c2")).toBeNull();
    // Other channels have limits of their own.
    expect(await r.manager.registerIncoming({ callId: "t1", callControlId: "ct1", from: "browser", to: "test call", channel: "test" })).toBeNull();
    await r.manager.hangup("t1", "test over");

    await r.manager.declineIncoming({ ...c2, declined: "busy", reason: "declined: 1 calls at once reached" });
    await r.persistence.flush();
    expect(await r.repo.getCall("c2")).toMatchObject({ channel: "phone", declined: "busy", status: "ended", endedBy: "system" });
    expect(r.manager.activeCalls).toBe(1);

    await r.manager.hangup("c1", "caller hung up");
    expect(await r.manager.registerIncoming({ ...c2, callId: "c3", callControlId: "cc3" })).toBeNull();
    expect(await r.repo.getCall("c3")).toMatchObject({ channel: "phone", declined: null });
  });

  test("a channel's max_call_seconds caps the call flow's", async () => {
    const r = await rig();
    r.config.flow.timing.time_up = undefined;
    // Below the schema's minimum, so the test runs quickly.
    r.config.limits.phone.max_call_seconds = 0.2;
    await r.manager.attachMedia("c1", NO_MEDIA, "pcma");
    while ((await r.repo.getCall("c1"))?.status !== "ended") await Bun.sleep(10);
    expect((await r.repo.getCall("c1"))?.endReason).toBe("max call length reached");
  });
});
