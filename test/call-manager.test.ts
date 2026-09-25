import { describe, expect, test } from "bun:test";
import { openSqlite, SqliteRepo } from "../src/adapters/storage/sqlite";
import { CallManager, NO_MEDIA } from "../src/core/call-manager";
import { MemoryEventBus } from "../src/core/event-bus";
import { attachPersistence } from "../src/core/persist";
import type { Agent } from "../src/core/ports";
import { loadRepoConfig, scripted } from "./helpers";

async function rig(agent: Agent = { run: async () => ({ toolCalls: [] }), summarize: async () => "" }) {
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
    notifier: { sms: async () => {} },
    telephony: { hangup: async () => {} },
    clock: { now: () => Date.now() },
    ownerNumber: "",
    repo,
    blobs: { put: async (k) => k, get: async () => null },
  });
  await manager.registerIncoming({ callId: "c1", callControlId: "cc1", from: "+441", to: "+442" });
  return { manager, repo, persistence, connects: () => connects };
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
      summarize: async () => (await new Promise<void>((res) => (release = res)), "Sarah called about dinner."),
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

  test("no new session starts once shutdown has begun", async () => {
    const r = await rig();
    const attach = r.manager.attachMedia("c1", NO_MEDIA, "pcma"); // still reading the call record
    await r.manager.stopAll("server shutting down");
    await expect(attach).rejects.toThrow("server shutting down");
    expect(r.connects()).toBe(0);
  });
});
