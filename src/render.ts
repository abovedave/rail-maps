// Draws a line graph at each zoom step with LOOM's `transitmap`, and saves
// the drawn lines as coordinates for maps to show.
//
//   node src/render.ts     reads out/gb.map.<zoom>.json, writes out/gb.transit.json
//
// transitmap does the hard part of drawing: lines side by side along each
// corridor, in loom's order, with curves where they join, cross or branch
// at junctions. Its widths are in map units, so each zoom step is drawn
// with widths matching a fixed number of screen points at that zoom, with
// only the lines shown at that zoom (LINES in lines.ts), from the graph for
// its zoom band (bands.ts): simpler further out.
//
// Writes every step to one file for maps (the app and web/), with each line
// as a Google encoded polyline, and each band's station dots (see
// stationDots), as they're where its lines are: { linePoints, pitchPoints,
// widths: { colour: points }, darkColours: { colour: colour }, stationSets:
// [[[name, lon, lat, angle, colour, …]]], steps: [{ zoom, stations: index in
// stationSets, drawn: the zoom it's drawn for, bundled: lines side by side
// (widths keep in step with the spacing either side of drawn), lines: [[colour, polyline]] }] }. A step is shown
// from its zoom until the next step's (to the nearest whole zoom).

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { BANDS, bandAt, mapFile } from './bands.ts'
import { LINES, lineColour, lineStyle } from './lines.ts'


/** Space between lines, in screen points. Each line gets a slot as wide as
 *  the widest line (LINES in lines.ts), so wide lines (Intercity) are
 *  as clear of their neighbours as the rest; lines are drawn at their own
 *  width in the middle of their slot. */
const GAP_POINTS = 1
const SLOT_POINTS = Math.max(...Object.values(LINES).map((s) => s.width))
/** Lines' width where the map has none for a line. */
const DEFAULT_POINTS = 1
/** The furthest out the map is drawn. */
const MIN_ZOOM = 5
/** From this zoom in, lines sharing track are drawn side by side. Further
 *  out each corridor is one line, in its most important line's colour
 *  (priority): side by side, their bundles are wider than the junctions they
 *  turn through and fold into knots. At MIN_ZOOM, lines are side by side
 *  throughout, their bundles shrinking to single lines zoomed out. */
const BUNDLE_ZOOM = 5
/** The zooms lines side by side are drawn for: the same lines, with spacing
 *  of a fixed number of points at each, so the map swaps between them as it
 *  zooms (from a level before each), scaling widths in between. */
const BUNDLE_DRAWN = [13]
/** Which line a corridor is drawn as, zoomed out: Intercity, then lines
 *  with their own name, then National Rail. */
const priority = (line: string) => (line === 'Intercity' ? 0 : line === 'National Rail' ? 2 : 1)
/** Web Mercator metres per screen point at zoom 0. */
const METRES_AT_ZOOM_0 = 156_543.034

/** Each band's graph, by its file. */
const bandGraphs = new Map(BANDS.map((b) => [mapFile(b), readFileSync(mapFile(b))]))

/** The graph for a zoom level, with only the lines drawn there (see LINES),
 *  so zoomed out shows the main network. Edges left with no lines go. */
const graphs = new Map<string, Buffer>()
function graphAt(zoom: number, band = bandAt(zoom)): Buffer {
  const file = mapFile(band)
  const parsed = JSON.parse(bandGraphs.get(file)!.toString())
  const drawn = (id: string) => lineStyle(id).minZoom <= zoom
  const lines = new Set<string>()
  for (const f of parsed.features) if (f.geometry.type === 'LineString') for (const l of f.properties.lines) if (drawn(l.id)) lines.add(l.id)
  const key = `${file} ${[...lines].sort().join('|')}`
  if (!graphs.has(key)) {
    parsed.features = parsed.features.flatMap((f: any) => {
      if (f.geometry.type !== 'LineString') return [f]
      const kept = f.properties.lines.filter((l: any) => drawn(l.id))
      return kept.length ? [{ ...f, properties: { ...f.properties, lines: kept } }] : []
    })
    graphs.set(key, Buffer.from(JSON.stringify(parsed)))
  }
  return graphs.get(key)!
}
const R = 6_378_137
const fromMercator = (x: number, y: number): [number, number] =>
  [(x / R) * (180 / Math.PI), (Math.atan(Math.exp(y / R)) * 360) / Math.PI - 90]
const mercX = (lon: number) => (lon * Math.PI * R) / 180
const mercY = (lat: number) => R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))

/** Douglas–Peucker on flat points, keeping both ends. */
function simplify(p: [number, number][], tolerance: number) {
  if (p.length <= 2) return p
  const keep = new Uint8Array(p.length)
  keep[0] = keep[p.length - 1] = 1
  const stack: [number, number][] = [[0, p.length - 1]]
  while (stack.length) {
    const [s, e] = stack.pop()!
    const [ax, ay] = p[s], [bx, by] = p[e]
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy
    let worst = -1, index = -1
    for (let i = s + 1; i < e; i++) {
      const t = len2 ? Math.max(0, Math.min(1, ((p[i][0] - ax) * dx + (p[i][1] - ay) * dy) / len2)) : 0
      const d = Math.hypot(p[i][0] - (ax + t * dx), p[i][1] - (ay + t * dy))
      if (d > worst) { worst = d; index = i }
    }
    if (worst > tolerance) { keep[index] = 1; stack.push([s, index], [index, e]) }
  }
  return p.filter((_, i) => keep[i])
}

/** Joins pieces of one colour whose ends meet (within `tolerance`, either
 *  way round) into longer lines, so maps have far fewer lines to draw:
 *  transitmap draws each edge and each junction curve as its own piece. */
function join(pieces: { colour: string; points: [number, number][] }[], tolerance: number) {
  const key = (colour: string, [x, y]: [number, number]) => `${colour}|${Math.round(x / tolerance)},${Math.round(y / tolerance)}`
  /** Piece ends by where they are: piece index × 2, + 1 for its last point. */
  const ends = new Map<string, number[]>()
  pieces.forEach((p, i) => {
    for (const [end, point] of [[0, p.points[0]], [1, p.points[p.points.length - 1]]] as const) {
      const k = key(p.colour, point)
      ;(ends.get(k) ?? ends.set(k, []).get(k)!).push(i * 2 + end)
    }
  })
  const used = new Uint8Array(pieces.length)
  /** An unused piece of this colour with an end here, and which end. */
  const meeting = (colour: string, point: [number, number]) => {
    const end = ends.get(key(colour, point))?.find((e) => !used[e >> 1])
    if (end !== undefined) used[end >> 1] = 1
    return end
  }
  const joined: typeof pieces = []
  pieces.forEach(({ colour, points: first }, i) => {
    if (used[i]) return
    used[i] = 1
    let points = [...first]
    // Onwards from its last point, then back from its first
    for (let end; (end = meeting(colour, points[points.length - 1])) !== undefined;) {
      const next = pieces[end >> 1].points
      points.push(...(end & 1 ? [...next].reverse() : next).slice(1))
    }
    for (let end; (end = meeting(colour, points[0])) !== undefined;) {
      const before = pieces[end >> 1].points
      points = [...(end & 1 ? before : [...before].reverse()).slice(0, -1), ...points]
    }
    joined.push({ colour, points })
  })
  return joined
}

/** A line with its corners rounded off (Chaikin's corner cutting, twice),
 *  keeping both ends. */
function rounded(p: [number, number][]) {
  for (let pass = 0; pass < 2 && p.length > 2; pass++) {
    const next: [number, number][] = [p[0]]
    for (let i = 0; i < p.length - 1; i++) {
      const [[ax, ay], [bx, by]] = [p[i], p[i + 1]]
      if (i > 0) next.push([0.75 * ax + 0.25 * bx, 0.75 * ay + 0.25 * by])
      if (i < p.length - 2) next.push([0.25 * ax + 0.75 * bx, 0.25 * ay + 0.75 * by])
    }
    next.push(p[p.length - 1])
    p = next
  }
  return p
}

/** Google's encoded polyline format (5 decimal places), from flat
 *  lon, lat pairs. */
function encode(flat: number[]): string {
  let out = '', lastLat = 0, lastLon = 0
  const put = (value: number) => {
    let v = value < 0 ? ~(value << 1) : value << 1
    while (v >= 0x20) { out += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5 }
    out += String.fromCharCode(v + 63)
  }
  for (let i = 0; i < flat.length; i += 2) {
    const lat = Math.round(flat[i + 1] * 1e5), lon = Math.round(flat[i] * 1e5)
    put(lat - lastLat); put(lon - lastLon)
    lastLat = lat; lastLon = lon
  }
  return out
}

/** Every step's lines, encoded. */
// Zoomed out, lines aren't side by side, so a drawing doesn't depend on the
// zoom: one is drawn for each set of lines shown (LINES' minZoom), with the
// detail of the closest zoom it's shown at. Closer in, one for all zooms.
const shownAt = (zoom: number) => Object.keys(LINES).filter((l) => lineStyle(l).minZoom <= zoom).join('|')
const drawings: { zoom: number; detail: number; bundled: boolean }[] = []
for (let zoom = MIN_ZOOM; zoom < BUNDLE_ZOOM; zoom++) {
  const last = drawings[drawings.length - 1]
  if (last && shownAt(last.zoom) === shownAt(zoom)) last.detail = zoom
  else drawings.push({ zoom, detail: zoom, bundled: false })
}
for (const [i, drawn] of BUNDLE_DRAWN.entries()) {
  drawings.push({ zoom: i ? drawn - 1 : BUNDLE_ZOOM, detail: drawn, bundled: true })
}

const steps: { zoom: number; drawn: number; bundled: boolean; stations: number; lines: string[][] }[] = []
for (const { zoom, detail, bundled: isBundled } of drawings) {
  const metresPerPoint = METRES_AT_ZOOM_0 / 2 ** detail
  // Each from the graph for the zoom it's drawn for: merged further out
  const band = bandAt(isBundled ? detail : zoom)
  const pieces = isBundled ? bundled(detail, metresPerPoint, band) : centrelines(zoom, metresPerPoint)
  const toLonLat = (points: [number, number][]) =>
    (isBundled ? simplify(points, metresPerPoint / 4) : points)
      .flatMap(([x, y]) => fromMercator(x, y).map((v) => Math.round(v * 1e6) / 1e6))
  const lines = join(pieces, metresPerPoint / 2).map(({ colour, points }) => [colour, encode(toLonLat(points))])
  steps.push({ zoom, drawn: detail, bundled: isBundled, stations: BANDS.indexOf(band), lines })
  console.error(`zoom ${zoom}${detail > zoom ? `–${detail}` : ''}: ${lines.length} lines`)
}

/** A zoom level's lines drawn side by side by transitmap, in Web Mercator
 *  metres. */
function bundled(zoom: number, metresPerPoint: number, band: (typeof BANDS)[number]) {
  const svg = spawnSync('vendor/loom/build/transitmap', [
    '--line-width', String(SLOT_POINTS * metresPerPoint),
    '--line-spacing', String(GAP_POINTS * metresPerPoint),
    '--outline-width', '0', '--no-render-stations',
  ], { input: graphAt(zoom, band), maxBuffer: 1 << 30 }).stdout.toString()

  // SVG units to Web Mercator metres, from its bounding box
  const head = /latlng-box="([^"]+)" viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg)!
  const [west, south, east, north] = head[1].split(',').map(Number)
  const scaleX = (mercX(east) - mercX(west)) / Number(head[2])
  const scaleY = (mercY(north) - mercY(south)) / Number(head[3])

  const pieces: { colour: string; points: [number, number][] }[] = []
  for (const m of svg.matchAll(/<polyline class="(?:transit-edge|\s*inner-geom)[^"]*" points="([^"]+)" style="[^"]*stroke:#([0-9A-Fa-f]{6})/g)) {
    const points = m[1].trim().split(/\s+/).map((pair) => {
      const [x, y] = pair.split(',').map(Number)
      return [mercX(west) + x * scaleX, mercY(north) - y * scaleY] as [number, number]
    })
    if (points.length > 1) pieces.push({ colour: m[2].toLowerCase(), points })
  }
  return pieces
}

/** A zoom level's corridors, each as one line along the graph in its most
 *  important line's colour, in Web Mercator metres: simplified further than
 *  bundles, with corners rounded, each between its junctions so lines still
 *  meet there. */
function centrelines(zoom: number, metresPerPoint: number) {
  return (JSON.parse(graphAt(zoom).toString()).features as any[])
    .filter((f) => f.geometry.type === 'LineString')
    .map((f) => {
      const line = [...f.properties.lines].sort((a: any, b: any) => priority(a.id) - priority(b.id))[0]
      return {
        colour: lineColour(line.id).toLowerCase(),
        points: rounded(simplify((f.geometry.coordinates as [number, number][]).map(([lon, lat]) => [mercX(lon), mercY(lat)] as [number, number]), metresPerPoint)),
      }
    })
}

writeFileSync('out/gb.transit.json', JSON.stringify({
  linePoints: DEFAULT_POINTS, pitchPoints: SLOT_POINTS + GAP_POINTS, widths: lineWidths(), darkColours: darkColours(),
  stationSets: BANDS.map((b) => stationDots(bandGraphs.get(mapFile(b))!)), steps,
}))

/** Each line's width in points, by colour, where it isn't the default. */
function lineWidths() {
  const features = JSON.parse(bandGraphs.get(mapFile(BANDS[0]))!.toString()).features as any[]
  const ids = new Set<string>(features.flatMap((f) => (f.geometry.type === 'LineString' ? f.properties.lines.map((l: any) => l.id) : [])))
  return Object.fromEntries([...ids].filter((id) => lineStyle(id).width !== DEFAULT_POINTS).map((id) => [lineColour(id).toLowerCase(), lineStyle(id).width]))
}

/** Each line's colour on dark maps, by its colour, where it has one. */
function darkColours() {
  return Object.fromEntries(Object.values(LINES).filter((s) => s.dark).map((s) => [s.colour.toLowerCase(), s.dark!.toLowerCase()]))
}

/** Each station's dots, one on each line calling there, for apps to draw
 *  across the lines in screen points: [name, lon, lat, angle, colour, …].
 *  The angle is the corridor's direction at the station, in degrees
 *  clockwise from east on a north-up map, and the colours run from its
 *  right to its left, LOOM's order, so the first colour's line is drawn
 *  furthest right looking along it. Lines are pitchPoints apart (centre to
 *  centre), centred on the station. */
function stationDots(graph: Buffer) {
  return grouped(stopDots(graph))
}

/** Stops grouped into stations: each OSM stop is its own station in the
 *  graph (see linegraph.ts), so of stops with the same name close together,
 *  only those showing a line no other does are kept, the one with the most
 *  lines first. Where a station's lines share platforms that's one set of
 *  dots; where they're apart (Whitechapel), each line's are on it. */
function grouped(stops: any[][]) {
  const kept: any[][] = []
  for (const stop of [...stops].sort((a, b) => b.length - a.length)) {
    const [name, lon, lat] = stop
    const covered = kept.some((k) => k[0] === name
      && Math.hypot((k[1] - lon) * 69_400, (k[2] - lat) * 111_320) < 500
      && stop.slice(4).every((c: string) => k.slice(4).includes(c)))
    if (!covered) kept.push(stop)
  }
  return kept
}

/** Each stop's dots. */
function stopDots(graph: Buffer) {
  const features = JSON.parse(graph.toString()).features as any[]
  const edgesAt = new Map<string, any[]>()
  for (const f of features) {
    if (f.geometry.type !== 'LineString') continue
    for (const n of [f.properties.from, f.properties.to]) (edgesAt.get(n) ?? edgesAt.set(n, []).get(n)!).push(f)
  }
  return features.filter((f) => f.geometry.type === 'Point' && f.properties.station_label).flatMap((f) => {
    const p = f.properties
    // The corridor with the most lines through the station
    const edge = (edgesAt.get(p.id) ?? []).sort((a, b) => b.properties.lines.length - a.properties.lines.length)[0]
    if (!edge) return []
    const notServing = new Set<string>(p.not_serving ?? [])
    const colours = (edge.properties.lines as any[]).filter((l) => !notServing.has(l.id)).map((l) => (l.color as string).toLowerCase())
    if (!colours.length) return []
    // Its direction (from → to) over the first or last 30 m at the station
    const c = (edge.geometry.coordinates as [number, number][]).map(([lon, lat]) => [mercX(lon), mercY(lat)] as [number, number])
    const atStart = edge.properties.from === p.id
    const path = atStart ? c : [...c].reverse()
    let i = 1
    while (i < path.length - 1 && Math.hypot(path[i][0] - path[0][0], path[i][1] - path[0][1]) < 30) i++
    let [dx, dy] = [path[i][0] - path[0][0], path[i][1] - path[0][1]]
    if (!atStart) [dx, dy] = [-dx, -dy]
    const angle = Math.round((-Math.atan2(dy, dx) * 180) / Math.PI * 10) / 10
    const [lon, lat] = f.geometry.coordinates
    return [[p.station_label, Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6, angle, ...colours]]
  })
}
