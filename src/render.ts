// Draws the line graph at each zoom step with LOOM's `transitmap`, and saves
// the drawn lines as coordinates for maps to show.
//
//   node src/render.ts     reads out/gb.map.json, writes out/gb.transit.json
//
// transitmap does the hard part of drawing: lines side by side along each
// corridor, in loom's order, with curves where they join, cross or branch
// at junctions. Its widths are in map units, so each step is drawn with
// widths matching a fixed number of screen points at the zoom it's drawn
// for, and maps widen and narrow them from there.
//
// Writes every step to one file for maps (the app and web/), with each line
// as a Google encoded polyline, and the station dots (see stationDots):
// { linePoints, pitchPoints, darkColours: { colour: colour },
// stations: [[name, lon, lat, angle, colour, …]], steps: [{ zoom, drawn: the
// zoom it's drawn for, lines: [[colour, polyline]] }] }. A step is shown
// from its zoom until the next step's (to the nearest whole zoom).

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { encode, simplify } from './geo.ts'
import { LINES } from './lines.ts'
import type { LatLon } from './osm.ts'

/** Lines' width, and the space between them, in screen points at the zoom
 *  they're drawn for. */
const LINE_POINTS = 2
const GAP_POINTS = 1
/** The furthest out the map is drawn. */
const MIN_ZOOM = 5
/** The zooms the map is drawn for, the first shown from MIN_ZOOM and each
 *  other from a level before: the same lines, spaced a fixed number of
 *  points apart at each, as spacing is fixed on the ground. Maps widen and
 *  narrow lines in between, and simplify them further out. */
const DRAWN_ZOOMS = [13, 16]
/** Web Mercator metres per screen point at zoom 0. */
const METRES_AT_ZOOM_0 = 156_543.034

const graph = readFileSync('out/gb.map.json')

const R = 6_378_137
const fromMercator = (x: number, y: number): [number, number] =>
  [(x / R) * (180 / Math.PI), (Math.atan(Math.exp(y / R)) * 360) / Math.PI - 90]
const mercX = (lon: number) => (lon * Math.PI * R) / 180
const mercY = (lat: number) => R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))

/** Joins pieces of one colour whose ends meet (within `tolerance`, either
 *  way round) into longer lines, so maps have far fewer lines to draw:
 *  transitmap draws each edge and each junction curve as its own piece. */
function join(pieces: { colour: string; points: [number, number][] }[], tolerance: number) {
  // Ends by grid cell, a tolerance wide: ends that meet are in the same or a
  // neighbouring cell
  const cell = (colour: string, x: number, y: number) => `${colour}|${x},${y}`
  const at = (p: { points: [number, number][] }, end: number) => p.points[end ? p.points.length - 1 : 0]
  /** Piece ends by cell: piece index × 2, + 1 for its last point. */
  const ends = new Map<string, number[]>()
  pieces.forEach((p, i) => {
    for (const end of [0, 1]) {
      const [x, y] = at(p, end)
      const k = cell(p.colour, Math.round(x / tolerance), Math.round(y / tolerance))
      ;(ends.get(k) ?? ends.set(k, []).get(k)!).push(i * 2 + end)
    }
  })
  const used = new Uint8Array(pieces.length)
  /** The closest unused piece of this colour with an end within tolerance,
   *  and which end. */
  const meeting = (colour: string, [x, y]: [number, number]) => {
    const [cx, cy] = [Math.round(x / tolerance), Math.round(y / tolerance)]
    let best: number | undefined, bestDistance = tolerance
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const e of ends.get(cell(colour, cx + dx, cy + dy)) ?? []) {
        if (used[e >> 1]) continue
        const [ex, ey] = at(pieces[e >> 1], e & 1)
        const distance = Math.hypot(ex - x, ey - y)
        if (distance <= bestDistance) [best, bestDistance] = [e, distance]
      }
    }
    if (best !== undefined) used[best >> 1] = 1
    return best
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

/** Every step's lines, encoded. */
const steps: { zoom: number; drawn: number; lines: string[][] }[] = []
for (const { zoom, drawn } of STEPS) {
  const metresPerPoint = METRES_AT_ZOOM_0 / 2 ** drawn
  const round = (v: number) => Math.round(v * 1e6) / 1e6
  const toLatLon = (points: [number, number][]) =>
    simplify(points, metresPerPoint / 4).map(([x, y]): LatLon => { const [lon, lat] = fromMercator(x, y); return [round(lat), round(lon)] })
  const lines = join(drawing(metresPerPoint), metresPerPoint / 2).map(({ colour, points }) => [colour, encode(toLatLon(points))])
  steps.push({ zoom, drawn, lines })
  console.error(`zoom ${zoom}+ (drawn for ${drawn}): ${lines.length} lines`)
}

/** The lines drawn side by side by transitmap at a scale, in Web Mercator
 *  metres. */
function drawing(metresPerPoint: number) {
  const svg = spawnSync('vendor/loom/build/transitmap', [
    '--line-width', String(LINE_POINTS * metresPerPoint),
    '--line-spacing', String(GAP_POINTS * metresPerPoint),
    '--outline-width', '0', '--no-render-stations',
  ], { input: graph, maxBuffer: 1 << 30 }).stdout.toString()

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

writeFileSync('out/gb.transit.json', JSON.stringify({
  linePoints: LINE_POINTS, pitchPoints: LINE_POINTS + GAP_POINTS, darkColours: darkColours(),
  stations: stationDots(graph), steps,
}))

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
    // The corridor with the most lines calling at the station (others may
    // pass through without calling: the Elizabeth line at Moorgate)
    const notServing = new Set<string>(p.not_serving ?? [])
    const calling = (e: any) => e.properties.lines.filter((l: any) => !notServing.has(l.id)).length
    const edge = (edgesAt.get(p.id) ?? []).sort((a, b) => calling(b) - calling(a) || b.properties.lines.length - a.properties.lines.length)[0]
    if (!edge) return []
    // A dot on each line
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
