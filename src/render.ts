// Writes the map for maps to show (the app and web/), out/gb.transit.json,
// from the line graph (out/gb.map.json, with out/gb.lines.json,
// out/gb.names.json and out/gb.stations.json).
//
//   node src/render.ts
//
// Zoomed out (from MIN_ZOOM), the map is an overview: each line on its own
// track, over each other where they share it, drawn here (see overview).
// Side by side there, lines crowd: London's termini knot into one bundle,
// and squeezed closer their colours blur. Maps widen and narrow its lines
// as Apple's roads do.
//
// Zoomed in (from SIDE_BY_SIDE_ZOOM), lines sharing track are drawn side by
// side by the map itself, from the ordered line graph (see lineGraph, and
// web/bundles.js): pitchPoints apart (centre to centre) at zoom 14,
// doubling every two levels in, two thirds of that wide, up to 3 points.
//
// The file: { linePoints, pitchPoints, labelPoints, labelNames: [[text,
// colour]] (labels' `name` indexes it), darkColours: { colour: colour },
// stations: [[name, lon, lat, angle, colour, …]] (see stationDots), graph
// (see lineGraph), steps: [{ zoom, drawn: the zoom it's drawn for, overview:
// true for the overview, lines: [[colour, polyline]] (the overview's),
// labels: line names (see labels.ts), [[name, positions as a polyline,
// angles as encoded whole degrees clockwise from east, sides as encoded
// half pitches]] }] }. A step is shown from its zoom until the next step's
// (to the nearest whole zoom). Lines are Google encoded polylines.

import { readFileSync, writeFileSync } from 'node:fs'
import { encode, encodeIntegers, fromMercator, mercX, mercY, METRES_AT_ZOOM_0, simplify, simplifyLatLon } from './geo.ts'
import { type Graph, isEdge, isNode, readGraph, readStationKeys } from './graph.ts'
import { LABEL_POINTS, nameIndex, placeLabels } from './labels.ts'
import { LINES } from './lines.ts'
import type { LatLon } from './osm.ts'
import { darkColours, stationDots } from './stations.ts'

/** Lines' width, and the space between them, in screen points at zoom 14. */
const LINE_POINTS = 2
const PITCH_POINTS = 3
/** The furthest out the map is drawn, and where lines go side by side. */
const MIN_ZOOM = 5
const SIDE_BY_SIDE_ZOOM = 13
/** Each step's first zoom, and the zoom it's drawn (or its names placed)
 *  for. The overview is drawn twice: simply further out, and in more
 *  detail, with line names, from LABELS_ZOOM. Side by side, only names are
 *  placed for each step: maps draw the lines. */
const STEPS = [
  { zoom: MIN_ZOOM, drawn: 10, overview: true },
  { zoom: 11, drawn: 12, overview: true },
  { zoom: SIDE_BY_SIDE_ZOOM, drawn: 14, overview: false },
  { zoom: 15, drawn: 16, overview: false },
  { zoom: 17, drawn: 18, overview: false },
]
/** Lines are named (labels.ts) in steps shown from this zoom and closer. */
const LABELS_ZOOM = 11
/** The overview's drawing order, last on top: National Rail at the bottom,
 *  then each network known by name, the first in LINES on top. */
const OVERVIEW_ORDER = [...Object.keys(LINES).filter((line) => line !== 'National Rail'), 'National Rail']

const graph = readGraph('out/gb.map.json')

/** Joins pieces of one colour whose ends meet (within `tolerance`, either
 *  way round) into longer lines, so maps have far fewer lines to draw. */
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

/** Each line on each edge of the line graph, along the edge's centreline in
 *  Web Mercator metres, with its side of it (pitches to the right, looking
 *  from `from` to `to`; loom's first line is furthest right): for placing
 *  names on lines maps draw side by side. */
function sideBySide() {
  return graph.features.filter(isEdge).flatMap((e) => {
    const points = e.geometry.coordinates.map(([lon, lat]): [number, number] => [mercX(lon), mercY(lat)])
    const n = e.properties.lines.length
    return e.properties.lines.map((l, slot) => ({ colour: l.color.toLowerCase(), points, side: (n - 1) / 2 - slot }))
  })
}

/** How far the line graph's edges can stray from their track when
 *  simplified, in metres. */
const GRAPH_SIMPLIFY = 3

/** The ordered line graph, for maps to draw lines side by side themselves
 *  (web/bundles.js): { lines: [[id, colour]], nodes: [[lon, lat]], edges:
 *  [[from, to, encoded polyline from → to, line indexes]], bans: [[node,
 *  line, neighbour, neighbour]] }. An edge's first line is drawn furthest
 *  right, looking from `from` to `to` (loom's order); a ban is a turn a line
 *  can't make at a node, between two of its neighbours. */
function lineGraph(g: Graph) {
  const lines: [string, string][] = [], lineIndex = new Map<string, number>()
  const nodes: [number, number][] = [], nodeIndex = new Map<string, number>()
  const round = (v: number) => Math.round(v * 1e6) / 1e6
  for (const n of g.features.filter(isNode)) {
    nodeIndex.set(n.properties.id, nodes.length)
    nodes.push([round(n.geometry.coordinates[0]), round(n.geometry.coordinates[1])])
  }
  const lineOf = (id: string, colour: string) => {
    if (!lineIndex.has(id)) { lineIndex.set(id, lines.length); lines.push([id, colour.toLowerCase()]) }
    return lineIndex.get(id)!
  }
  const edges = g.features.filter(isEdge).map((e) => {
    const path = simplifyLatLon(e.geometry.coordinates.map(([lon, lat]): LatLon => [lat, lon]), GRAPH_SIMPLIFY)
    return [nodeIndex.get(e.properties.from)!, nodeIndex.get(e.properties.to)!, encode(path), e.properties.lines.map((l) => lineOf(l.id, l.color))]
  })
  const bans = g.features.filter(isNode).flatMap((n) => (n.properties.excluded_conn ?? [])
    .filter((c) => lineIndex.has(c.line) && nodeIndex.has(c.node_from) && nodeIndex.has(c.node_to))
    .map((c) => [nodeIndex.get(n.properties.id)!, lineIndex.get(c.line)!, nodeIndex.get(c.node_from)!, nodeIndex.get(c.node_to)!]))
  return { lines, nodes, edges, bans }
}

/** Every line name used, [text, colour], for steps' labels to refer to. */
const labelNames: [string, string][] = []
const labelIndex = new Map<string, number>()
/** A step's names, as [name index, positions as an encoded polyline, angles
 *  as encoded whole degrees, sides as encoded half pitches], one entry per
 *  name. */
function encodeLabels(labels: (string | number)[][]) {
  const byName = new Map<number, { points: LatLon[]; angles: number[]; sides: number[] }>()
  for (const [text, colour, lon, lat, angle, side] of labels) {
    const key = `${text}|${colour}`
    if (!labelIndex.has(key)) { labelIndex.set(key, labelNames.length); labelNames.push([text as string, colour as string]) }
    const i = labelIndex.get(key)!
    const entry = byName.get(i) ?? byName.set(i, { points: [], angles: [], sides: [] }).get(i)!
    entry.points.push([lat as number, lon as number])
    entry.angles.push(angle as number)
    entry.sides.push((side as number) * 2)
  }
  return [...byName].map(([i, { points, angles, sides }]) => [i, encode(points), encodeIntegers(angles), encodeIntegers(sides)])
}

const stations = stationDots(graph, readStationKeys('out/gb.stations.json'))
const stationPoints = stations.map((s): [number, number] => [mercX(s[1]), mercY(s[2])])
const nameAt = nameIndex(JSON.parse(readFileSync('out/gb.names.json', 'utf8')), ([lon, lat]) => [mercX(lon), mercY(lat)])

const overviewPieces = overview()
const edgePieces = sideBySide()
const steps: { zoom: number; drawn: number; overview?: true; lines?: string[][]; labels: (string | number)[][] }[] = []
for (const { zoom, drawn, overview: isOverview } of STEPS) {
  const metresPerPoint = METRES_AT_ZOOM_0 / 2 ** drawn
  const round = (v: number) => Math.round(v * 1e6) / 1e6
  const toLatLon = (points: [number, number][]) =>
    simplify(points, metresPerPoint / 4).map(([x, y]): LatLon => { const [lon, lat] = fromMercator(x, y); return [round(lat), round(lon)] })
  const pieces = isOverview ? join(overviewPieces, metresPerPoint / 2) : edgePieces
  const labels = zoom >= LABELS_ZOOM ? placeLabels(pieces, metresPerPoint, stationPoints, nameAt, fromMercator) : []
  if (isOverview) {
    steps.push({ zoom, drawn, overview: true, lines: pieces.map(({ colour, points }) => [colour, encode(toLatLon(points))]), labels: encodeLabels(labels) })
  } else {
    steps.push({ zoom, drawn, labels: encodeLabels(labels) })
  }
  console.error(`zoom ${zoom}+ (drawn for ${drawn}): ${isOverview ? `${pieces.length} lines, ` : ''}${labels.length} names`)
}

writeFileSync('out/gb.transit.json', JSON.stringify({
  linePoints: LINE_POINTS, pitchPoints: PITCH_POINTS, labelPoints: LABEL_POINTS, labelNames, darkColours: darkColours(),
  stations, steps, graph: lineGraph(graph),
}))
