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
// zoom it's drawn for, pitch: its lines' pitch if not pitchPoints, overview:
// true for the overview, lines: [[colour, polyline]], labels: line names (see labels.ts), [[name, positions as a polyline, angles as encoded whole degrees
// clockwise from east]] }], labelNames: [[text, colour]] (labels' `name`
// indexes it), labelPoints: their text size }. A step is shown
// from its zoom until the next step's (to the nearest whole zoom).

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { encode, encodeIntegers, fromMercator, mercX, mercY, METRES_AT_ZOOM_0, simplify } from './geo.ts'
import { LABEL_POINTS, nameIndex, placeLabels } from './labels.ts'
import type { Graph } from './graph.ts'
import { LINES } from './lines.ts'
import { darkColours, stationDots } from './stations.ts'
import type { LatLon } from './osm.ts'

/** Lines' width, and the space between them, in screen points at the zoom
 *  they're drawn for (the space for each drawing in SIDE_BY_SIDE). */
const LINE_POINTS = 2
const GAP_POINTS = 1
/** The furthest out the map is drawn. */
const MIN_ZOOM = 5
/** Zoomed in, lines sharing track are drawn side by side, by transitmap,
 *  a drawing for every other zoom (SIDE_BY_SIDE), each shown from a level
 *  before it to half a level after. Spacing is fixed on the ground, so a
 *  drawing's lines are twice as far apart a level in, and half a level out
 *  of their own. Each drawing's spacing is double the one before's, so
 *  where one drawing gives way to the next, spacing only halves, as it
 *  would with a drawing for every zoom: maps keep lines two thirds of their
 *  spacing wide, from 0.2 to 3 points (`overview` unset, see web/map.js).
 *  Further out, from MIN_ZOOM, the map is an overview instead: each line on
 *  its own track, over each other where they share it (see overview). Side
 *  by side there, lines crowd: drawn for their own zoom they'd be hundreds
 *  of metres apart, knotting London's termini into one bundle, and squeezed
 *  closer their colours blur. Nor is anything moved off its track, as tidy
 *  moves lines to draw them side by side. Maps widen and narrow its lines
 *  as Apple's roads do. */
const SIDE_BY_SIDE = [{ drawn: 14, gap: GAP_POINTS }, { drawn: 16, gap: 4 }, { drawn: 18, gap: 10 }]
/** Each step's first zoom, the zoom it's drawn for, the space between its
 *  lines, and whether it's the overview. The overview is drawn twice: simply further out, and in more
 *  detail, with line names, from LABELS_ZOOM. */
const STEPS = [
  { zoom: MIN_ZOOM, drawn: 10, gap: GAP_POINTS, overview: true },
  { zoom: 11, drawn: 12, gap: GAP_POINTS, overview: true },
  ...SIDE_BY_SIDE.map(({ drawn, gap }) => ({ zoom: drawn - 1, drawn, gap, overview: false })),
]
/** The overview's drawing order, last on top: National Rail at the bottom,
 *  then each network known by name, the first in LINES on top. */
const OVERVIEW_ORDER = [...Object.keys(LINES).filter((line) => line !== 'National Rail'), 'National Rail']

const graph = readFileSync('out/gb.map.json')
const graphJson: Graph = JSON.parse(graph.toString())

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
/** Lines are named (labels.ts) in steps shown from this zoom and closer. */
const LABELS_ZOOM = 11

const stations = stationDots(graphJson)
const stationPoints = stations.map((s): [number, number] => [mercX(s[1]), mercY(s[2])])
const nameAt = nameIndex(JSON.parse(readFileSync('out/gb.names.json', 'utf8')), ([lon, lat]) => [mercX(lon), mercY(lat)])

/** Every line name used, [text, colour], for steps' labels to refer to. */
const labelNames: [string, string][] = []
const labelIndex = new Map<string, number>()
/** A step's names, as [name index, positions as an encoded polyline, angles
 *  as encoded whole degrees], one entry per name. */
function encodeLabels(labels: (string | number)[][]) {
  const byName = new Map<number, { points: LatLon[]; angles: number[] }>()
  for (const [text, colour, lon, lat, angle] of labels) {
    const key = `${text}|${colour}`
    if (!labelIndex.has(key)) { labelIndex.set(key, labelNames.length); labelNames.push([text as string, colour as string]) }
    const i = labelIndex.get(key)!
    const entry = byName.get(i) ?? byName.set(i, { points: [], angles: [] }).get(i)!
    entry.points.push([lat as number, lon as number])
    entry.angles.push(angle as number)
  }
  return [...byName].map(([i, { points, angles }]) => [i, encode(points), encodeIntegers(angles)])
}

/** The overview's lines, for each step drawn as the overview. */
const overviewPieces = overview()
const steps: { zoom: number; drawn: number; pitch?: number; overview?: true; lines: string[][]; labels: (string | number)[][] }[] = []
for (const { zoom, drawn, gap, overview: isOverview } of STEPS) {
  const metresPerPoint = METRES_AT_ZOOM_0 / 2 ** drawn
  const round = (v: number) => Math.round(v * 1e6) / 1e6
  const toLatLon = (points: [number, number][]) =>
    simplify(points, metresPerPoint / 4).map(([x, y]): LatLon => { const [lon, lat] = fromMercator(x, y); return [round(lat), round(lon)] })
  const joined = join(isOverview ? overviewPieces : drawing(metresPerPoint, gap), metresPerPoint / 2)
  const lines = joined.map(({ colour, points }) => [colour, encode(toLatLon(points))])
  const labels = zoom >= LABELS_ZOOM ? placeLabels(joined, metresPerPoint, stationPoints, nameAt, fromMercator) : []
  steps.push({ zoom, drawn, ...(gap !== GAP_POINTS && { pitch: LINE_POINTS + gap }), ...(isOverview && { overview: true as const }), lines, labels: encodeLabels(labels) })
  console.error(`zoom ${zoom}+ (drawn for ${drawn}): ${lines.length} lines, ${labels.length} names`)
}

/** Each line on its own track, in Web Mercator metres: its tracks merged
 *  into one centreline on their own (lines.json, from topo's first pass),
 *  before lines merge with each other or tidy moves anything. Lines on
 *  track they share are drawn over each other rather than side by side,
 *  National Rail first and each named network over it (OVERVIEW_ORDER), so
 *  nothing is moved off its track. */
function overview() {
  const rank = (line: string) => { const i = OVERVIEW_ORDER.indexOf(line); return i < 0 ? OVERVIEW_ORDER.length : i }
  const pieces: { colour: string; points: [number, number][]; rank: number }[] = []
  for (const { geometry, properties } of JSON.parse(readFileSync('out/gb.lines.json', 'utf8')).features) {
    if (geometry.type !== 'LineString') continue
    const points = geometry.coordinates.map(([lon, lat]: number[]): [number, number] => [mercX(lon), mercY(lat)])
    for (const line of properties.lines ?? []) pieces.push({ colour: line.color.toLowerCase(), points, rank: rank(line.id) })
  }
  return pieces.sort((a, b) => b.rank - a.rank)
}

/** The lines drawn side by side by transitmap at a scale, in Web Mercator
 *  metres. */
function drawing(metresPerPoint: number, gap: number) {
  const svg = spawnSync('vendor/loom/build/transitmap', [
    '--line-width', String(LINE_POINTS * metresPerPoint),
    '--line-spacing', String(gap * metresPerPoint),
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
  linePoints: LINE_POINTS, pitchPoints: LINE_POINTS + GAP_POINTS, labelPoints: LABEL_POINTS, labelNames, darkColours: darkColours(),
  stations, steps,
}))
