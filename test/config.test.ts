import { describe, expect, test } from "bun:test";
import { YamlDirSource } from "../src/adapters/config/yaml-fs";
import { ConfigError, fillCurrentTime, fillPlaceholders, loadConfig, parseConfig, type ConfigName } from "../src/core/config";
import { loadRepoConfig } from "./helpers";

describe("config", () => {
  test("repo config/*.yaml files are valid", async () => {
    const cfg = await loadRepoConfig();
    expect(cfg.live.greeting).toBe("Hello?");
    expect(cfg.connection.media_stream.codec).toBe("pcma");
    expect(cfg.connection.media_stream.noise_suppression.direction).toBe("outbound");
    expect(cfg.flow.rules.length).toBeGreaterThan(0);
    expect(cfg.jev.questions.urgency.levels.length).toBeGreaterThanOrEqual(2);
  });

  test("live voice: built-in name or custom id; typos rejected", () => {
    const base = { instructions: "x", greeting: "Hello?" };
    expect(parseConfig("live", base).voice).toBe("marin");
    expect(parseConfig("live", { ...base, voice: "cedar" }).voice).toBe("cedar");
    expect(parseConfig("live", { ...base, voice: { id: "voice_123" } }).voice).toEqual({ id: "voice_123" });
    expect(() => parseConfig("live", { ...base, voice: "marine" })).toThrow(ConfigError);
  });

  test("defaults are filled in", () => {
    const f = parseConfig("flow", { rules: [{ stage: "a" }] });
    expect(f.timing.classify).toEqual({ settle_ms: 600, max_wait_ms: 4000, retry_min_ms: 500, retry_max_ms: 8000 });
    expect(f.silence.max_prompts).toBe(2);
    expect(parseConfig("connection", {}).media_stream.codec).toBe("pcmu");
    expect(parseConfig("luna", { instructions: "x" }).limits).toEqual({ max_calls: 4, cooldown_ms: 15000 });
  });

  test("rejects out-of-range thresholds with a readable message", () => {
    expect(() => parseConfig("flow", { rules: [{ stage: "a", when: { verdict: { is: "scam", min: 1.5 } } }] })).toThrow(
      /call-flow\.yaml: rules\[a\]\.when\.verdict/,
    );
  });

  test("the loader checks call-flow.yaml against jev.yaml", async () => {
    const yaml = new YamlDirSource("./config");
    const source = {
      read: async (n: ConfigName) => {
        const raw = (await yaml.read(n)) as { questions: Record<string, unknown> };
        if (n === "jev") delete raw.questions.done;
        return raw;
      },
    };
    await expect(loadConfig(source)).rejects.toThrow(/call-flow\.yaml: rules\[wrap_up\]\.when\.done: no Choice question done/);
  });

  test("{owner_name} is filled in every config text, falling back to \"the owner\"", async () => {
    const yaml = new YamlDirSource("./config");
    // Checks the filling, not the prompts' wording.
    const named = JSON.stringify(await loadConfig(yaml, { ownerName: "Alex", agentLanguages: "English and Hungarian" }));
    expect(named).not.toMatch(/\{(owner_name|agent_languages)\}/);
    expect(named).toContain("Alex");
    expect(named).toContain("English and Hungarian");
    // Filled per Luna reply, not at load.
    expect(named).toContain("{luna_response}");
    const unnamed = JSON.stringify(await loadConfig(yaml));
    expect(unnamed).not.toMatch(/\{(owner_name|agent_languages)\}/);
    expect(unnamed).toContain("the owner");
    const cfg = await loadRepoConfig();
    cfg.flow.rules[0]!.then = { tell_live: { as: "instructions", text: "Tell {owner_name} later.", send: "now", max_hold_ms: null } };
    expect(fillPlaceholders(cfg, { ownerName: "Alex" }).flow.rules[0]!.then!.tell_live!.text).toBe("Tell Alex later.");
  });

  test("{current_time} is left for sending, in Live's, Jev's and Luna's prompts only", async () => {
    const cfg = await loadConfig(new YamlDirSource("./config"));
    for (const text of [cfg.live.instructions, cfg.jev.context, cfg.luna.instructions]) expect(text).toContain("{current_time}");
    expect(fillCurrentTime("It is {current_time}.", Date.UTC(2026, 8, 25, 18, 10))).toBe("It is Fri 2026-Sep-25 19:10 BST.");
    expect(fillCurrentTime("{current_time}", Date.UTC(2026, 11, 1, 9, 5))).toBe("Tue 2026-Dec-01 09:05 GMT");
    const raw = await loadRepoConfig();
    raw.live.greeting = "Hello, it's {current_time}";
    expect(() => fillPlaceholders(raw)).toThrow(/live\.yaml: greeting: unknown placeholder \{current_time\}/);
  });

  test("rejects unknown placeholders, naming where they are", async () => {
    const cfg = await loadRepoConfig();
    cfg.live.greeting = "Hello, {owner}'s phone";
    expect(() => fillPlaceholders(cfg)).toThrow(/live\.yaml: greeting: unknown placeholder \{owner\}/);
    cfg.live.greeting = "Hello, {luna_response}"; // only call-flow.yaml texts get Luna's reply
    expect(() => fillPlaceholders(cfg)).toThrow(/live\.yaml: greeting: unknown placeholder \{luna_response\}/);
  });

  test("rejects unknown Luna tools", () => {
    expect(() => parseConfig("luna", { instructions: "x", tools: ["transfer_money"] })).toThrow(ConfigError);
  });

  test("rejects a Jev urgency score with more than 10 levels", async () => {
    const cfg = await loadRepoConfig();
    const jev = structuredClone(cfg.jev);
    jev.questions.urgency.levels = Array.from({ length: 11 }, (_, i) => `level ${i}`);
    expect(() => parseConfig("jev", jev)).toThrow(ConfigError);
  });

  test("ConfigStore tells listeners about reloads", async () => {
    const { ConfigStore } = await import("../src/core/config");
    const a = await loadRepoConfig();
    const store = new ConfigStore(a);
    const seen: unknown[] = [];
    const off = store.onChange((c) => void seen.push(c));
    const b = structuredClone(a);
    store.set(b);
    off();
    store.set(a);
    expect(seen).toEqual([b]);
  });
});
