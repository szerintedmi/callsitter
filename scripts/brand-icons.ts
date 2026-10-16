// Renders the site icon (src/web/favicon.ts) to PNGs in assets/: the YouTube profile picture and a
// transparent 512 px one for other profiles. `bun run brand-icons`. The site serves its own
// favicon.ico and apple-touch-icon.png from the same grid (iconRoutes).
import { mkdirSync } from "node:fs";
import { COLORS, iconPng } from "../src/web/favicon";

// YouTube crops the 800×800 upload to a circle, so the octagon keeps a margin and an opaque ink back.
const OUT = {
  "callsitter-youtube.png": await iconPng(28, 800, COLORS.K),
  "callsitter-512.png": await iconPng(21, 512),
};
mkdirSync("assets", { recursive: true });
for (const [name, data] of Object.entries(OUT)) {
  await Bun.write(`assets/${name}`, data);
  console.log(`assets/${name}`);
}
