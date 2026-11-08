// The map is drawn from a simpler line graph the further out it's shown:
// zoomed out, lines are drawn wider on the ground, so junctions and splits
// closer together than the lines are wide can't be drawn and are merged.

/** From each zoom in, the map is drawn from a graph with tracks up to
 *  `merge` metres apart merged (topo's `-d`), and the cleanup in tidy.ts
 *  scaled by `tidy`. The first is built by scripts/build.sh, the rest by
 *  simplify.ts, each from the one before. Merging much further than 300 m
 *  merges neighbouring corridors (in London, most of them), so every line is
 *  drawn on all of them: zoomed out, there are fewer lines instead (LINES in
 *  lines.ts). */
export const BANDS = [
  { minZoom: 13, merge: 95, tidy: 1 },
  { minZoom: 0, merge: 300, tidy: 3 },
]

/** topo's distances are Web Mercator metres: about 1.6 to a metre on the
 *  ground in Britain. */
export const MERCATOR_METRES = 1.6

/** The band a zoom level is drawn from. */
export const bandAt = (zoom: number) => BANDS.find((b) => zoom >= b.minZoom)!

/** Its graph, from loom. */
export const mapFile = (band: (typeof BANDS)[number]) => `out/gb.map.${band.minZoom}.json`
