# GB Transit Map

Transit map overlays of Britain's railways, built from OpenStreetMap: the
National Rail network, with a few networks people know by name in their own
colours.

## Quick start

Needs Node 24+, osmium and cmake (`brew install node osmium-tool cmake`).

```sh
npm run setup                # build LOOM, download the GB extract (~2 GB)
npm run build                # all of Britain: about 10 minutes, 24 GB of memory
echo APPLE_MAPKIT_TOKEN=… > .env
npm run web                  # http://localhost:8080
```

`npm run loom` clones and builds LOOM into `vendor/loom`; `npm run osm`
downloads the extract into `vendor/osm`, or a newer one if Geofabrik has it
(they update it daily). `npm run setup` does both.

## Pipeline

| Step | Tool | Output |
|---|---|---|
| 1. Download | `npm run osm`: Geofabrik's Great Britain extract | `vendor/osm/great-britain-latest.osm.pbf` |
| 2. Line graph | `src/linegraph.ts`: every `route=train` relation, via osmium | `out/gb.linegraph.json` |
| 3. Merge | `src/topo.ts`, with LOOM `topo`: each layer's parallel tracks (the Elizabeth line, the Overground, main line) up to about 95 m apart become one smoothed corridor, then layers merge where they share track (about 60 m), so lines on different tracks nearby (the Elizabeth line under Whitechapel) stay apart | `out/gb.topo.json` |
| 4. Zoom bands | `src/simplify.ts`, for each zoom band in `src/bands.ts`: merges further with `topo` the further out it's drawn, tidies knots `topo` leaves (`src/tidy.ts`: close junctions become one, short parallel ways one), and orders the lines on each corridor with LOOM `loom` | `out/gb.map.<zoom>.json` |
| 5. Draw | `src/render.ts`: one line per track, in its line's colour (or LOOM `transitmap` for lines side by side, if `BUNDLE_DRAWN` is set) | `out/gb.transit.json` |
| 6. Show | `web/map.js` with MapKit JS, or the app | the map |

**Lines.** National Rail is one line, the base network, rather than one per
train company. A few networks people know by name have their own line,
drawn over it where they share track: the Elizabeth line, London Overground
(one orange line for all six), Thameslink, Southeastern, South Western Railway,
Heathrow Express, Merseyrail and the Tyne and Wear Metro. See `LINES` and
`OWN_LINES` in `src/lines.ts`, which also set each line's colour and width.
A route's company is matched against
`TRAIN_COMPANIES`, which lists the other names OSM uses for each. Routes of
no known company (heritage railways, mistagged track) are left out and
listed by the build.

**Drawing.** Each track is one 2 pt line, in the colour of the line using
it (a named line over National Rail), drawn from the 300 m graph out to zoom
12 and the detailed one closer in. Maps widen and narrow lines as Apple's
roads do (`MKRoadWidthAtZoomScale` in the app, the same widths in
`web/map.js`). Stations are a dot in their line's colour, or white zoomed
out. (`BUNDLE_DRAWN` in `src/render.ts` instead draws lines sharing track
side by side with LOOM's `transitmap`, at the zooms listed.) `out/gb.svg` is a preview of the whole network.

## Updating the app

the app (in `../the app`) shows `out/gb.transit.json` and builds its own
track graph for routing from the same extract in `vendor/osm/`:

```sh
npm run osm                      # latest OSM extract
npm run build                    # all of Britain: about 10 minutes, 24 GB of memory
npm run app                 # copy out/gb.transit.json into the app
(cd ../app/api && npm run tracks)
```

Changing how lines are grouped or coloured (`src/lines.ts`) needs the whole
build. Changing line width or spacing (`src/render.ts`) needs only
`npm run render` (about a minute), and colours, widths and zoom levels
(`LINES` in `src/lines.ts`) the same. Changing zoom bands or tidying
(`src/bands.ts`, `src/tidy.ts`) needs `node src/simplify.ts` (a few
minutes), then `npm run render`.

## Output

`out/gb.transit.json` is every zoom step in one compact file for apps:
lines as Google encoded polylines, and each station's position, direction
and the colours of the lines calling there, for drawing its dots (one set
for each zoom band, as lines are merged further out).

`out/gb.map.<zoom>.json` (one for each zoom band) is LOOM's GeoJSON line graph: `LineString` edges with
`from`, `to` and an ordered `lines` array (`id`, `label`, `color`), and
`Point` nodes, with `station_id` and `station_label` for stations. The first
line in an edge's `lines` is drawn furthest right, looking from `from` to `to`.

## Licences

This project is MIT. [LOOM](https://github.com/ad-freiburg/loom) is GPL-3.0
and is fetched and run as a separate program, not bundled. Map data ©
OpenStreetMap contributors, ODbL.
