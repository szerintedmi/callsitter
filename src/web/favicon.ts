// The site icon: a ringing phone handset on an amber octagon (a stop sign for calls), 24×24.
// A = amber, K = ink (the site palette); "." is transparent. The handset and its waves are the white
// shapes of the "Software_Telephone_Call_Handset_Signal_Ringing" sprite from the 1-bit Pixel Icons
// pack, unscaled: show the icon only at whole multiples of 24 px, or the pixels smear.
export const GRID = [
  ".......AAAAAAAAAA.......",
  "......AAAAAAAAAAAA......",
  ".....AAAAAAAAAAAAAA.....",
  "....AAAAAAAAAAAAAAAA....",
  "...AAAAAAAAAAAAAAAAAA...",
  "..AAAAAAAAAAAAAAAAAAAA..",
  ".AAAAAAAAKKKAAAKAAAAAAA.",
  "AAAAAAAAKAAAAAKKKAAAAAAA",
  "AAAAAAAKAAKKAKKKKAAAAAAA",
  "AAAAAAKAAKAAAKKKKAAAAAAA",
  "AAAAAAKAKAAAAAKKKAAAAAAA",
  "AAAAAAKAKAAAAAKKKAAAAAAA",
  "AAAAAAAAAAAAAKKKAAAAAAAA",
  "AAAAAAAAKKAAKKKKAAAAAAAA",
  "AAAAAAAKKKKKKKKAAAAAAAAA",
  "AAAAAAKKKKKKKKAAAAAAAAAA",
  "AAAAAAAKKKKKAAAAAAAAAAAA",
  ".AAAAAAAAAAAAAAAAAAAAAA.",
  "..AAAAAAAAAAAAAAAAAAAA..",
  "...AAAAAAAAAAAAAAAAAA...",
  "....AAAAAAAAAAAAAAAA....",
  ".....AAAAAAAAAAAAAA.....",
  "......AAAAAAAAAAAA......",
  ".......AAAAAAAAAA.......",
];
export const COLORS: Record<string, string> = { A: "#ffb000", K: "#0e0d10" };

/** One path per color, each row's runs as rectangles. */
function svg() {
  const paths = Object.entries(COLORS).map(([key, fill]) => {
    let d = "";
    GRID.forEach((row, y) => {
      for (const m of row.matchAll(new RegExp(`${key}+`, "g"))) d += `M${m.index} ${y}h${m[0].length}v1h-${m[0].length}z`;
    });
    return `<path fill="${fill}" d="${d}"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID.length} ${GRID.length}" shape-rendering="crispEdges">${paths.join("")}</svg>`;
}

/** A data URI for `<link rel="icon">`, so no route serves it. */
export const favicon = `data:image/svg+xml,${encodeURIComponent(svg())}`;

/** The same icon beside the CALLSITTER wordmark; `.logo` sets its size (keep it a multiple of 24 px). */
export const logo = `<img class="logo" src="${favicon}" alt="">`;
