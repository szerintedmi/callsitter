import type { Context } from "hono";

/** Changes on every server start: the pages' script URLs carry it (?v=), so a deploy loads fresh scripts. */
export const BUILD = Date.now().toString(36);

/** The page scripts (src/web/client) by file name; `rebuilds`: compiled afresh per request (dev). */
export type ClientAssets = ((name: string) => Promise<string | undefined>) & { rebuilds?: boolean };

/**
 * A page script under /assets/. Under this build's ?v= it's kept for a year (the next deploy changes
 * the URL); any other URL, or a dev server's rebuilt code, is revalidated on every load.
 */
export async function serveScript(c: Context, assets: ClientAssets, name: string) {
  const body = await assets(name);
  if (body === undefined) return c.notFound();
  const fixed = !assets.rebuilds && c.req.query("v") === BUILD;
  return new Response(body, {
    headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": fixed ? "max-age=31536000, immutable" : "no-cache" },
  });
}
