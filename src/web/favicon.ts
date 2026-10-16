// The tab icon: an amber pixel shield guarding a phone handset, drawn on a 16×16 grid so it stays
// crisp at tab size. A = amber, K = ink, W = paper (the site palette); "." is transparent.
const GRID = [
  "................",
  "......AAAA......",
  "....AAAAAAAA....",
  "..AAAAAAAAAAAA..",
  ".AWAKKKAAAAAAAA.",
  ".AAKKKKAAAAAAAA.",
  ".AAKKKKAAAAAAAA.",
  ".AAAKKKAAAAAAAA.",
  ".AAAKKKKAAAAAAA.",
  "..AAAKKKKAKKAA..",
  "..AAAAKKKKKKAA..",
  "...AAAAKKKKKA...",
  "....AAAAAAAA....",
  ".....AAAAAA.....",
  "......AAAA......",
  "................",
];
const COLORS: Record<string, string> = { A: "#ffb000", K: "#0e0d10", W: "#fff6ec" };

/** One path per color, each row's runs as rectangles. */
function svg() {
  const paths = Object.entries(COLORS).map(([key, fill]) => {
    let d = "";
    GRID.forEach((row, y) => {
      for (const m of row.matchAll(new RegExp(`${key}+`, "g"))) d += `M${m.index} ${y}h${m[0].length}v1h-${m[0].length}z`;
    });
    return `<path fill="${fill}" d="${d}"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">${paths.join("")}</svg>`;
}

/** A data URI for `<link rel="icon">`, so no route serves it. */
export const favicon = `data:image/svg+xml,${encodeURIComponent(svg())}`;
