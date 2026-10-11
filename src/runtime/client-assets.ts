import { basename, join } from "node:path";
import type { ClientAssets } from "../web/admin";

const CLIENT_DIR = join(import.meta.dir, "../web/client");
/** One classic script per page, served as /assets/<name>.js; shared modules are bundled into each. */
const ENTRIES = ["calls", "call", "test-call", "test-call-worklet", "public", "listen"];

/** Compiles the browser code in src/web/client (TypeScript) to browser JavaScript, by file name. */
export async function buildClient(): Promise<Map<string, string>> {
  const out = await Bun.build({
    entrypoints: ENTRIES.map((e) => join(CLIENT_DIR, `${e}.ts`)),
    target: "browser",
    format: "iife",
    naming: "[name].[ext]",
  });
  if (!out.success) throw new AggregateError(out.logs, "client build failed");
  return new Map(await Promise.all(out.outputs.map(async (o) => [basename(o.path), await o.text()] as const)));
}

/**
 * Builds the client once now (a compile error stops startup). With `rebuild`, every request
 * compiles it afresh, so `bun --watch` (which only watches the server's imports) still serves
 * edited page code on reload.
 */
export async function clientAssets(opts: { rebuild: boolean }): Promise<ClientAssets> {
  const built = await buildClient();
  return async (name) => (opts.rebuild ? await buildClient() : built).get(name);
}
