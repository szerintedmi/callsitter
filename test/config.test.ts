import { describe, expect, test } from "bun:test";
import { YamlDirSource } from "../src/adapters/config/yaml-fs";
import { checkLimits, ConfigError, fillCurrentTime, fillPlaceholders, loadConfig, parseConfig, publicChatConfig, type ChannelLimits, type ConfigName } from "../src/core/config";
import { loadConfigWithLuna, loadRepoConfig } from "./helpers";

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
    expect(parseConfig("public", {})).toMatchObject({ notify_per_ip_per_day: 5 });
    const none = { max_spend_usd_per_day: null, max_calls_per_day: null, max_concurrent_calls: null, max_calls_per_caller_per_day: null, max_call_seconds: null };
    expect(parseConfig("limits", {})).toEqual({ phone: none, test: none, public: none });
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

  test("Luna's mid-call instructions are required once call-flow.yaml asks her mid-call", async () => {
    const yaml = new YamlDirSource("./config");
    const withLunaRule = {
      read: async (n: ConfigName) => {
        const raw = (await yaml.read(n)) as { rules: unknown[] };
        if (n === "flow") raw.rules.push({ stage: "ask", then: { ask_luna: true } });
        return raw;
      },
    };
    await expect(loadConfig(withLunaRule)).rejects.toThrow(/luna\.yaml: instructions: needed, call-flow\.yaml asks Luna mid-call/);
    await expect(loadConfigWithLuna()).resolves.toBeDefined();
  });

  test("telegram.yaml stage buttons must name a call-flow stage with a fixed tell_live", async () => {
    const yaml = new YamlDirSource("./config");
    const withButton = (stage: string) => ({
      read: async (n: ConfigName) => {
        const raw = (await yaml.read(n)) as { steering: { buttons: unknown[] } };
        if (n === "telegram") raw.steering.buttons = [{ label: "X", stage }];
        return raw;
      },
    });
    await expect(loadConfig(withButton("genuine"))).resolves.toBeDefined();
    await expect(loadConfig(withButton("still_unclear"))).rejects.toThrow(/steering\.buttons\.0\.stage: no call-flow\.yaml rule still_unclear/);
    await expect(loadConfig(withButton("low_confidence"))).rejects.toThrow(/no call-flow\.yaml rule low_confidence with tell_live \(and no ask_luna\)/);
  });

  test("{owner_name} is filled in every config text, falling back to \"the owner\"", async () => {
    const yaml = new YamlDirSource("./config");
    // Checks the filling, not the prompts' wording.
    const named = JSON.stringify(await loadConfig(yaml, { ownerName: "Alex", agentLanguages: "English and Hungarian" }));
    expect(named).not.toMatch(/\{(owner_name|agent_languages)\}/);
    expect(named).toContain("Alex");
    expect(named).toContain("English and Hungarian");
    const unnamed = JSON.stringify(await loadConfig(yaml));
    expect(unnamed).not.toMatch(/\{(owner_name|agent_languages)\}/);
    expect(unnamed).toContain("the owner");
    const cfg = await loadRepoConfig();
    cfg.flow.rules[0]!.then = { tell_live: { as: "instructions", text: "Tell {owner_name} later.", send: "now", max_hold_ms: null } };
    expect(fillPlaceholders(cfg, { ownerName: "Alex" }).flow.rules[0]!.then!.tell_live!.text).toBe("Tell Alex later.");
  });

  test("{current_time} is left for sending, in Live's, Jev's and Luna's prompts only", async () => {
    const cfg = await loadConfigWithLuna();
    for (const text of [cfg.live.instructions, cfg.jev.context, cfg.luna.instructions]) expect(text).toContain("{current_time}");
    // Filled per Luna reply, not at load.
    expect(JSON.stringify(cfg.flow)).toContain("{luna_response}");
    expect(fillCurrentTime("It is {current_time}.", Date.UTC(2026, 8, 25, 18, 10))).toBe("It is Fri 2026-Sep-25 19:10 BST.");
    expect(fillCurrentTime("{current_time}", Date.UTC(2026, 11, 1, 9, 5))).toBe("Tue 2026-Dec-01 09:05 GMT");
    const raw = await loadRepoConfig();
    raw.live.greeting = "Hello, it's {current_time}";
    expect(() => fillPlaceholders(raw)).toThrow(/live\.yaml: greeting: unknown placeholder \{current_time\}/);
  });

  test("{caller_number} is left for call start, in Live's prompt only", async () => {
    const cfg = await loadConfigWithLuna();
    expect(cfg.live.instructions).toContain("{caller_number}");
    const raw = await loadRepoConfig();
    raw.live.greeting = "Hello, {caller_number}";
    expect(() => fillPlaceholders(raw)).toThrow(/live\.yaml: greeting: unknown placeholder \{caller_number\}/);
  });

  test("rejects unknown placeholders, naming where they are", async () => {
    const cfg = await loadRepoConfig();
    cfg.live.greeting = "Hello, {owner}'s phone";
    expect(() => fillPlaceholders(cfg)).toThrow(/live\.yaml: greeting: unknown placeholder \{owner\}/);
    cfg.live.greeting = "Hello, {luna_response}"; // only call-flow.yaml texts get Luna's reply
    expect(() => fillPlaceholders(cfg)).toThrow(/live\.yaml: greeting: unknown placeholder \{luna_response\}/);
  });

  test("{owner_message} is left for each steering message, in telegram.yaml steering.text only", async () => {
    const cfg = await loadRepoConfig();
    expect(cfg.telegram.steering.text).toContain("{owner_message}");
    expect(fillPlaceholders(cfg).telegram.steering.text).toContain("{owner_message}");
    cfg.live.greeting = "Hello, {owner_message}";
    expect(() => fillPlaceholders(cfg)).toThrow(/live\.yaml: greeting: unknown placeholder \{owner_message\}/);
    expect(() => parseConfig("telegram", { steering: { text: "SUPERVISOR: hi" } })).toThrow(/needs \{owner_message\}/);
    expect(() => parseConfig("telegram", { steering: { prefixes: { "!": "shout" } } })).toThrow(ConfigError);
  });

  test("telegram.public: defaults, and applied over status in the public chat's view", async () => {
    expect(parseConfig("telegram", {}).public).toEqual({ min_edit_interval_ms: 10_000, urgent_alert: false });
    expect(() => parseConfig("telegram", { public: { min_edit_interval_ms: 500 } })).toThrow(ConfigError);
    const cfg = await loadRepoConfig();
    const view = publicChatConfig(cfg);
    expect(view.telegram.status.min_edit_interval_ms).toBe(cfg.telegram.public.min_edit_interval_ms);
    expect(view.telegram.status.urgent_alert.enabled).toBe(false);
    expect(view.telegram.status.urgent_alert.min_urgency).toBe(cfg.telegram.status.urgent_alert.min_urgency);
    expect(view.telegram.steering).toBe(cfg.telegram.steering);
    expect(cfg.telegram.status.urgent_alert.enabled).toBe(true);
  });

  test("limits.yaml: null or left out is no limit, 0 is a cap; unknown keys rejected; the public page keeps its caps", async () => {
    const phone = parseConfig("limits", { phone: { max_spend_usd_per_day: 20 } }).phone;
    expect(phone).toMatchObject({ max_spend_usd_per_day: 20, max_calls_per_day: null, max_concurrent_calls: null });
    expect(parseConfig("limits", { phone: { max_spend_usd_per_day: null } }).phone.max_spend_usd_per_day).toBeNull();
    expect(parseConfig("limits", { phone: { max_spend_usd_per_day: 0 } }).phone.max_spend_usd_per_day).toBe(0);
    expect(() => parseConfig("limits", { phone: { daily_usd: 20 } })).toThrow(ConfigError);
    expect(() => parseConfig("limits", { mobile: {} })).toThrow(ConfigError);
    expect(() => parseConfig("limits", { phone: { max_spend_usd_per_day: -1 } })).toThrow(ConfigError);

    const cfg = await loadRepoConfig();
    expect(() => checkLimits(cfg.limits, cfg.flow)).not.toThrow();
    const without = (l: Partial<ChannelLimits>) => ({ ...cfg.limits, public: { ...cfg.limits.public, ...l } });
    expect(() => checkLimits(without({ max_spend_usd_per_day: null }), cfg.flow)).toThrow("public.max_spend_usd_per_day");
    expect(() => checkLimits(without({ max_concurrent_calls: null }), cfg.flow)).toThrow("public.max_concurrent_calls");
    expect(() => checkLimits(without({ max_call_seconds: cfg.flow.timing.max_call_seconds + 1 }), cfg.flow)).toThrow("longer than");
    expect(() => checkLimits({ ...cfg.limits, test: { ...cfg.limits.test, max_call_seconds: 10 } }, cfg.flow)).toThrow("time_up");
    // The phone's budget off: still valid.
    expect(() => checkLimits({ ...cfg.limits, phone: { ...cfg.limits.phone, max_spend_usd_per_day: null } }, cfg.flow)).not.toThrow();
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
