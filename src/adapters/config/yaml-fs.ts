import { watch } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { CONFIG_FILES, loadConfig, type ConfigName, type ConfigSource, type ConfigStore, type ConfigVars } from "../../core/config";

export class YamlDirSource implements ConfigSource {
  constructor(private dir: string) {}

  async read(name: ConfigName): Promise<unknown> {
    const path = join(this.dir, CONFIG_FILES[name]);
    const file = Bun.file(path);
    if (!(await file.exists())) throw new Error(`missing config file ${path}`);
    return YAML.parse(await file.text());
  }
}

/** Reloads config on file changes (dev). Invalid edits are logged and the old config is kept. */
export function watchConfig(dir: string, store: ConfigStore, vars: ConfigVars = {}): () => void {
  const source = new YamlDirSource(dir);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const w = watch(dir, (_event, file) => {
    if (!file?.endsWith(".yaml")) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        store.set(await loadConfig(source, vars));
        console.log(`[config] reloaded (${file})`);
      } catch (err) {
        console.error(`[config] reload failed, keeping previous config:\n${err instanceof Error ? err.message : err}`);
      }
    }, 200);
  });
  return () => w.close();
}
