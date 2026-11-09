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
// zoom it's drawn for, lines: [[colour, polyline]], labels: line names (see
// labels.ts), [[name, positions as a polyline, angles as encoded whole degrees
// clockwise from east]] }], labelNames: [[text, colour]] (labels' `name`
// indexes it), labelPoints: their text size }. A step is shown
// from its zoom until the next step's (to the nearest whole zoom).

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { encode, encodeIntegers, fromMercator, mercX, mercY, METRES_AT_ZOOM_0, simplify } from './geo.ts'
import { LABEL_POINTS, nameIndex, placeLabels } from './labels.ts'
import { darkColours, stationDots } from './stations.ts'
import type { LatLon } from './osm.ts'

/** Lines' width, and the space between them, in screen points at the zoom
 *  they're drawn for. */
const LINE_POINTS = 2
const GAP_POINTS = 1
/** The furthest out the map is drawn. */
const MIN_ZOOM = 5
/** Each whole zoom from MIN_DRAWN_ZOOM to MAX_DRAWN_ZOOM gets a drawing
 *  of its own, shown within half a level of it, so lines are always close
 *  to their set spacing: it's fixed on the ground, so a drawing's lines are
 *  twice as far apart a level in, and half a level out of their own. The
 *  first is also shown from MIN_ZOOM, where lines sharing track are close
 *  enough together to show as one: drawn for their own zoom, they'd be
 *  kilometres apart. */
const MIN_DRAWN_ZOOM = 9
const MAX_DRAWN_ZOOM = 18
/** Each step's first zoom and the zoom it's drawn for. Maps widen and
 *  narrow lines within a step, and simplify them further out. */
const STEPS = [
  { zoom: MIN_ZOOM, drawn: MIN_DRAWN_ZOOM },
  ...Array.from({ length: MAX_DRAWN_ZOOM - MIN_DRAWN_ZOOM }, (_, i) => ({ zoom: MIN_DRAWN_ZOOM + 1 + i, drawn: MIN_DRAWN_ZOOM + 1 + i })),
]

const graph = readFileSync('out/gb.map.json')

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
/** Lines are named (labels.ts) in drawings for this zoom and closer. */
const LABELS_ZOOM = 11

const stations = stationDots(graph)
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

const steps: { zoom: number; drawn: number; lines: string[][]; labels: (string | number)[][] }[] = []
for (const { zoom, drawn } of STEPS) {
  const metresPerPoint = METRES_AT_ZOOM_0 / 2 ** drawn
  const round = (v: number) => Math.round(v * 1e6) / 1e6
  const toLatLon = (points: [number, number][]) =>
    simplify(points, metresPerPoint / 4).map(([x, y]): LatLon => { const [lon, lat] = fromMercator(x, y); return [round(lat), round(lon)] })
  const joined = join(drawing(metresPerPoint), metresPerPoint / 2)
  const lines = joined.map(({ colour, points }) => [colour, encode(toLatLon(points))])
  const labels = drawn >= LABELS_ZOOM ? placeLabels(joined, metresPerPoint, stationPoints, nameAt, fromMercator) : []
  steps.push({ zoom, drawn, lines, labels: encodeLabels(labels) })
  console.error(`zoom ${zoom}+ (drawn for ${drawn}): ${lines.length} lines, ${labels.length} names`)
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
  linePoints: LINE_POINTS, pitchPoints: LINE_POINTS + GAP_POINTS, labelPoints: LABEL_POINTS, labelNames, darkColours: darkColours(),
  stations, steps,
}))
