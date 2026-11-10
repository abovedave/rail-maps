// Writes the map for maps to show (the app and web/), out/gb.transit.json,
// from the line graph (out/gb.map.json, with out/gb.names.json and
// out/gb.stations.json).
//
//   node map/render.ts
//
// Maps draw the lines themselves, side by side where they share track, from
// the ordered line graph (see lineGraph, and web/bundles.js): pitchPoints
// apart (centre to centre) at zoom 14, doubling every two levels in and
// halving every two out, but never closer than minPitchPoints; linePoints of
// pitchPoints of that wide, up to 3 points. Line names are placed here for each zoom step,
// along the track, with the side their line is drawn on.
//
// The file: { linePoints, pitchPoints, minPitchPoints, labelPoints,
// labelNames: [[text, colour]] (names' `name` indexes it), darkColours: {
// colour: colour }, stations: [[name, lon, lat, angle, colour, …]] (see
// stationDots), graph (see lineGraph), names: [{ zoom, labels: [[name,
// positions as a polyline, angles as encoded whole degrees clockwise from
// east, sides as encoded half pitches]] }] }. A zoom step's names are shown
// from its zoom until the next step's (to the nearest whole zoom), and none
// further out than the first. Lines are Google encoded polylines.

import { readFileSync, writeFileSync } from 'node:fs'
import { encode, encodeIntegers, fromMercator, mercX, mercY, METRES_AT_ZOOM_0, simplifyLatLon } from './lib/geo.ts'
import { type Graph, isEdge, isNode, readGraph, readStationKeys } from './lib/graph.ts'
import { LABEL_POINTS, nameIndex, placeLabels } from './lib/labels.ts'
import type { LatLon } from './lib/osm.ts'
import { darkColours, stationDots } from './lib/stations.ts'

/** Lines' width, and the space between them, in screen points at zoom 14,
 *  and the least space between them further out. */
const LINE_POINTS = 1.75
const PITCH_POINTS = 3.5
const MIN_PITCH_POINTS = 3

/** Line names are placed for each step from its first zoom, for the zoom
 *  it's placed for. */
const NAME_STEPS = [{ zoom: 11, placed: 12 }, { zoom: 13, placed: 14 }, { zoom: 15, placed: 16 }, { zoom: 17, placed: 18 }]

const graph = readGraph('out/gb.map.json')

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

const pieces = sideBySide()

const names = NAME_STEPS.map(({ zoom, placed }) => {
  const labels = placeLabels(pieces, METRES_AT_ZOOM_0 / 2 ** placed, stationPoints, nameAt, fromMercator)

  console.error(`zoom ${zoom}+ (placed for ${placed}): ${labels.length} names`)

  return { zoom, labels: encodeLabels(labels) }
})

writeFileSync('out/gb.transit.json', JSON.stringify({
  linePoints: LINE_POINTS, pitchPoints: PITCH_POINTS, minPitchPoints: MIN_PITCH_POINTS, labelPoints: LABEL_POINTS, labelNames,
  darkColours: darkColours(), stations, graph: lineGraph(graph), names,
}))
