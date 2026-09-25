#!/usr/bin/env bun
// Validates config/*.yaml against the Zod schemas.
import { YamlDirSource } from "../src/adapters/config/yaml-fs";
import { loadConfig } from "../src/core/config";

const dir = Bun.argv[2] ?? "./config";
try {
  const cfg = await loadConfig(new YamlDirSource(dir));
  console.log(`config OK: ${cfg.flow.rules.length} call-flow rules, Luna tools: ${cfg.luna.tools.join(", ")}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
