#!/bin/sh
# Builds Britain's transit map: OSM extract → line graph → topo (merge
# parallel track) → zoom bands (tidy, merge further out, loom orders lines)
# → transitmap drawings at each zoom step in out/gb.transit.json, plus an
# SVG preview.
set -e
extract=${OSM_EXTRACT:-vendor/osm/great-britain-latest.osm.pbf}
bin=vendor/loom/build
[ -x "$bin/topo" ] || npm run loom
[ -f "$extract" ] || npm run osm

mkdir -p out
echo "Line graph…" >&2
node src/linegraph.ts "$extract" > out/gb.linegraph.json
echo "topo…" >&2
# Merge parallel tracks into corridors, by layer then together, where lines
# share track (src/topo.ts)
node src/topo.ts out/gb.linegraph.json > out/gb.topo.json
echo "Zoom bands…" >&2
# Tidy what topo leaves, merge further for maps drawn further out, and order
# each one's lines with loom (src/bands.ts)
node src/simplify.ts
echo "Drawing…" >&2
node src/render.ts
"$bin/transitmap" -l --line-width 6 --line-spacing 3 --station-label-textsize 30 < out/gb.map.13.json > out/gb.svg
echo "Wrote out/gb.transit.json and out/gb.svg" >&2
