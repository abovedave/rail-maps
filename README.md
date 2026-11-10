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

`npm run build` runs steps 2 to 5 in turn (with the check after 4), then the track graph; each is
also its own script (`npm run linegraph`, `topo`, `tidy`, `render`,
`tracks`), to re-run from any step.

| Step | Tool | Output |
|---|---|---|
| 1. Download | `npm run osm`: Geofabrik's Great Britain extract | `vendor/osm/great-britain-latest.osm.pbf` |
| 2. Line graph | `src/linegraph.ts`: every `route=train` relation, via osmium | `out/gb.linegraph.json`, `out/gb.routes.json` |
| 3. Merge | `src/topo.ts`, with LOOM `topo`: each line's parallel tracks up to about 95 m apart become one smoothed corridor (about 30 m), then lines merge where they share track (about 50 m), so lines on different tracks nearby (the Elizabeth line under Whitechapel) stay apart | `out/gb.topo.json`, and the first pass in `out/gb.lines.json` |
| 4. Tidy and order | `src/tidy.ts` simplifies knots `topo` leaves (junctions under 200 m apart become one, short parallel ways one, station-free bypasses within 500 m of a route carrying the same lines are dropped, such as the Redhill avoiding line, a station's platforms linked by under 400 m of track become one, or under 1.5 km at a terminus, so its lines run in together, and turn restrictions the services show are wrong are lifted), then LOOM `loom` orders the lines on each corridor | `out/gb.map.json` |
| Check | `src/check.ts` (`npm run check`): every service in `out/gb.routes.json` (written by step 2) still runs unbroken from stop to stop on the finished graph; lists any breaks, by line | the build log |
| 5. Draw | `src/render.ts`: LOOM `transitmap` draws lines side by side for zooms 14, 16 and 18, and an overview further out | `out/gb.transit.json` |
| 6. Show | `web/map.js` with MapKit JS, or the app | the map |
| Track graph | `src/tracks.ts`: all running track, split at junctions and the app's stations, for routing trains along real track | `out/gb.tracks.json` |

`src/osm.ts` (reading the extract with osmium) and `src/geo.ts`
(simplifying and encoding lines) are shared by the steps.

**Lines.** National Rail is one line, the base network, rather than one per
train company. A few networks people know by name have their own line,
drawn over it where they share track: the Elizabeth line, London Overground
(one orange line for all six), Thameslink, Southeastern, South Western Railway,
Heathrow Express, Merseyrail and the Tyne and Wear Metro. See `LINES` and
`OWN_LINES` in `src/lines.ts`, which also set each line's colour.
Elizabeth line services that never enter its tunnel under central London,
ending at Liverpool Street's or Paddington's surface platforms, are drawn
as National Rail, as on TfL's map (`TUNNEL_STOPS` in `src/linegraph.ts`).
A route's company is matched against
`TRAIN_COMPANIES`, which lists the other names OSM uses for each. Routes of
no known company are drawn as National Rail if tagged `network` or
`operator` National Rail or Network Rail (the Felixstowe branch), and
otherwise (heritage railways, mistagged track) left out and listed by the
build.

**Drawing.** Zoomed out (zoom 5 to 12) the map is an overview: each line on
its own track, its parallel tracks merged into one centreline by topo's
first pass (`out/gb.lines.json`), before lines merge with each other or tidy
moves anything, drawn over each other where they share track (named networks
over National Rail). Side by side there, lines would knot London's termini
into a bundle and blur colours. Its lines widen and narrow as Apple's roads
do (`MKRoadWidthAtZoomScale` in the app, the same widths in `web/map.js`).

Zoomed in, lines sharing track are drawn side by side with LOOM's
`transitmap`, 2 pt wide with 1 pt between, for zooms 14, 16 and 18, each
shown from a level before to half a level after: `STEPS` in `src/render.ts`.
Spacing is fixed on the ground, so a drawing's lines spread apart as you
zoom in; maps keep lines two thirds of their spacing wide, from 0.2 to 3 pt
(`scaleAt` in `web/map.js`), and spread station dots with them.

The web preview takes `?lat=…&lon=…&z=…` to start at a place. `out/gb.svg`
is a preview of the whole network.

## Updating the app

the app (in `../the app`) shows `out/gb.transit.json`, and routes trains
along `out/gb.tracks.json`. The track graph snaps the app's stations
(`../app/api/public/stations.json`) to the track:

```sh
npm run osm                      # latest OSM extract
npm run build                    # all of Britain: about 10 minutes, 24 GB of memory
npm run app                 # copy both files into the app
```

Changing how lines are grouped or coloured (`src/lines.ts`) needs the whole
build. Changing line width, spacing or zooms (`src/render.ts`) needs only
`npm run render` (a few seconds), and colours (`LINES` in `src/lines.ts`)
the same. Changing tidying (`src/tidy.ts`) needs `npm run tidy`, then
`npm run render`.

## Output

`out/gb.transit.json` is every zoom step in one compact file for apps:
lines as Google encoded polylines, and each station's position, direction
and the colours of the lines calling there, for drawing its dots.

`out/gb.map.json` is LOOM's GeoJSON line graph: `LineString` edges with
`from`, `to` and an ordered `lines` array (`id`, `label`, `color`), and
`Point` nodes, with `station_id` and `station_label` for stations. The first
line in an edge's `lines` is drawn furthest right, looking from `from` to `to`.

## Licences

This project is MIT. [LOOM](https://github.com/ad-freiburg/loom) is GPL-3.0
and is fetched and run as a separate program, not bundled. Map data ©
OpenStreetMap contributors, ODbL.
