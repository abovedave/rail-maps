// Builds the rail track graph the app uses to draw a train's route along
// real track.
//
//   node map/tracks.ts <extract.osm.pbf> <stations.json> > tracks.json
//
// stations.json is the app's station list (`api/public/stations.json`
// there: { stations: [{ crs, lat, lon }] }).
//
// Keeps running lines (railway=rail without a service tag, so no sidings or
// yards, plus crossovers between parallel tracks; no heritage, military or
// industrial lines), splits them into edges at junctions and stations, and
// simplifies each edge. Writes:
//   edges     [fromNode, toNode, encoded polyline including both ends]
//   stations  { CRS: node }
// Track data © OpenStreetMap contributors, ODbL.

import { readFileSync } from 'node:fs'
import { encode, metres, simplifyLatLon } from './lib/geo.ts'
import { filtered, inNorthernIreland, type LatLon } from './lib/osm.ts'

const [pbf, stationsPath] = process.argv.slice(2)

if (!pbf || !stationsPath) {
  console.error('Usage: node map/tracks.ts <extract.osm.pbf> <stations.json>')
  process.exit(1)
}

/** Max distance from a station's location to the track, in metres. */
const STATION_SNAP_METRES = 400

/** Track in the open this close to a station is preferred to nearer track
 *  in a tunnel, in metres. Underground stations have none this close. */
const STATION_OPEN_METRES = 100

/** Douglas–Peucker tolerance when simplifying edges, in metres. */
const SIMPLIFY_METRES = 8

/** Disconnected pieces of track shorter than this (and with no station) are dropped. */
const MIN_COMPONENT_METRES = 2000

// MARK: Input

const EXCLUDED_USAGE = new Set(['tourism', 'military', 'industrial', 'test'])

/** Crossovers join parallel tracks (up and down lines mapped separately).
 *  Without them a route can't switch track between stations. */
const KEPT_SERVICE = new Set(['crossover'])

function isRunningLine(tags: Record<string, string>): boolean {
  return (
    tags.railway === 'rail' &&
    (!tags.service || KEPT_SERVICE.has(tags.service)) &&
    !EXCLUDED_USAGE.has(tags.usage ?? '') &&
    tags['railway:preserved'] !== 'yes'
  )
}

async function readRail(pbf: string) {
  const coords = new Map<number, LatLon>()
  const ways: number[][] = []

  /** Ways in tunnels: stations snap to them only with no other track near. */
  const tunnels = new Set<number[]>()

  for await (const e of filtered(pbf, ['w/railway=rail'])) {
    if (e.at) coords.set(e.id, e.at)

    if (e.type !== 'w' || !isRunningLine(e.tags) || !e.nodes!.length) continue

    ways.push(e.nodes!)

    if (e.tags.tunnel && e.tags.tunnel !== 'no') tunnels.add(e.nodes!)
  }

  const kept = ways.filter((nodes) => {
    const first = coords.get(nodes[0])

    return nodes.every((n) => coords.has(n)) && first && !inNorthernIreland(first)
  })

  console.error(`${kept.length} running-line ways, ${coords.size} nodes`)

  return { coords, ways: kept, tunnels }
}

// MARK: Geometry

function length(path: LatLon[]): number {
  let total = 0

  for (let i = 1; i < path.length; i++) total += metres(path[i - 1], path[i])

  return total
}

/** Points bucketed into square cells, for finding those near a point. */
class Grid<T> {
  private cells = new Map<number, { at: LatLon; item: T }[]>()
  readonly size: number
  private readonly dLat: number
  private readonly dLon: number

  constructor(size: number) {
    this.size = size
    this.dLat = size / 110_540
    this.dLon = size / (111_320 * Math.cos((54 * Math.PI) / 180))
  }

  private cell([lat, lon]: LatLon): [number, number] {
    return [Math.floor(lat / this.dLat), Math.floor((lon + 20) / this.dLon)]
  }

  add(at: LatLon, item: T) {
    const [y, x] = this.cell(at)
    const key = y * 1e6 + x

    this.cells.get(key)?.push({ at, item }) ?? this.cells.set(key, [{ at, item }])
  }

  /** Everything within `size` metres of a point, with how far away it is. */
  near(at: LatLon): { at: LatLon; item: T; metres: number }[] {
    const [y, x] = this.cell(at)
    const found: { at: LatLon; item: T; metres: number }[] = []

    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (const entry of this.cells.get((y + dy) * 1e6 + x + dx) ?? []) {
        const d = metres(at, entry.at)

        if (d <= this.size) found.push({ ...entry, metres: d })
      }
    }

    return found
  }
}

// MARK: Graph

interface Station { crs: string; lat: number; lon: number }

/** Nodes on a connected network of at least this many nodes. Stations snap
 *  only to these, so a stray fragment of track next to a station (as at
 *  Manchester Piccadilly) can't cut it off from the network. */
function networkNodes(ways: number[][], minimum = 100): Set<number> {
  const parent = new Map<number, number>()

  const find = (n: number): number => {
    let root = n

    while ((parent.get(root) ?? root) !== root) root = parent.get(root)!
    while (n !== root) { const next = parent.get(n) ?? n; parent.set(n, root); n = next }

    return root
  }

  for (const nodes of ways) for (let i = 1; i < nodes.length; i++) {
    const a = find(nodes[i - 1]), b = find(nodes[i])

    if (a !== b) parent.set(a, b)
  }

  const size = new Map<number, number>()
  const all = new Set(ways.flat())

  for (const n of all) size.set(find(n), (size.get(find(n)) ?? 0) + 1)

  return new Set([...all].filter((n) => (size.get(find(n)) ?? 0) >= minimum))
}

function snapStations(stations: Station[], coords: Map<number, LatLon>, ways: number[][], tunnels: Set<number[]>) {
  const network = networkNodes(ways)

  /** Nodes on track out in the open. */
  const open = new Set<number>()

  for (const nodes of ways) if (!tunnels.has(nodes)) for (const n of nodes) open.add(n)

  const grid = new Grid<number>(STATION_SNAP_METRES)

  for (const nodes of ways) for (const n of nodes) if (network.has(n)) grid.add(coords.get(n)!, n)

  const snapped = new Map<string, number>()
  const missing: string[] = []

  for (const s of stations) {
    // Nearest track, preferring track in the open when it's close: a
    // station above a tunnel (Highbury over HS1) is on the line above
    const near = grid.near([s.lat, s.lon]).sort((a, b) => a.metres - b.metres)
    const best = near.find((p) => open.has(p.item) && p.metres <= STATION_OPEN_METRES) ?? near[0]

    if (best) snapped.set(s.crs, best.item); else missing.push(s.crs)
  }

  return { snapped, missing }
}

interface Edge { from: number; to: number; path: LatLon[] }

function buildGraph(coords: Map<number, LatLon>, ways: number[][], stationNodes: Set<number>) {
  // Split points: way ends, nodes shared between ways (junctions), stations
  const uses = new Map<number, number>()

  for (const nodes of ways) for (const n of nodes) uses.set(n, (uses.get(n) ?? 0) + 1)

  const isSplit = (n: number, i: number, last: number) =>
    i === 0 || i === last || (uses.get(n) ?? 0) > 1 || stationNodes.has(n)

  const edges: Edge[] = []

  for (const nodes of ways) {
    let start = 0

    for (let i = 1; i < nodes.length; i++) {
      if (!isSplit(nodes[i], i, nodes.length - 1)) continue

      const path = nodes.slice(start, i + 1).map((n) => coords.get(n)!)

      if (nodes[start] !== nodes[i] || path.length > 2) edges.push({ from: nodes[start], to: nodes[i], path })

      start = i
    }
  }

  return edges
}

/** Drops small disconnected pieces of track that have no station. */
function pruneComponents(edges: Edge[], stationNodes: Set<number>) {
  const parent = new Map<number, number>()

  const find = (n: number): number => {
    let p = parent.get(n) ?? n

    if (p !== n) { p = find(p); parent.set(n, p) }

    return p
  }

  for (const e of edges) parent.set(find(e.from), find(e.to))

  const size = new Map<number, number>()
  const hasStation = new Set<number>()

  for (const e of edges) {
    const c = find(e.from)

    size.set(c, (size.get(c) ?? 0) + length(e.path))

    if (stationNodes.has(e.from) || stationNodes.has(e.to)) hasStation.add(c)
  }

  return edges.filter((e) => {
    const c = find(e.from)

    return hasStation.has(c) || (size.get(c) ?? 0) >= MIN_COMPONENT_METRES
  })
}

// MARK: Main

const { coords, ways, tunnels } = await readRail(pbf)

const stations: Station[] = JSON.parse(readFileSync(stationsPath, 'utf8')).stations
const { snapped, missing } = snapStations(stations, coords, ways, tunnels)

console.error(`Snapped ${snapped.size} stations; ${missing.length} not within ${STATION_SNAP_METRES} m of track`)

if (missing.length) console.error(`  e.g. ${missing.slice(0, 20).join(' ')}`)

const stationNodes = new Set(snapped.values())
const edges = pruneComponents(buildGraph(coords, ways, stationNodes), stationNodes)

// Number the nodes edges use
const index = new Map<number, number>()

const id = (n: number) => {
  let i = index.get(n)

  if (i === undefined) {
    i = index.size
    index.set(n, i)
  }

  return i
}

let points = 0

const out = {
  generatedAt: new Date().toISOString(),
  source: '© OpenStreetMap contributors (ODbL)',
  nodeCount: 0,
  edges: edges.map((e) => {
    const path = simplifyLatLon(e.path, SIMPLIFY_METRES)

    points += path.length

    return [id(e.from), id(e.to), encode(path)]
  }),
  stations: Object.fromEntries(
    [...snapped].filter(([, n]) => index.has(n)).map(([crs, n]) => [crs, index.get(n)!]),
  ),
}

out.nodeCount = index.size

const json = JSON.stringify(out)

process.stdout.write(json)

const km = Math.round(edges.reduce((sum, e) => sum + length(e.path), 0) / 1000)

console.error(
  `${index.size} nodes, ${out.edges.length} edges, ${points} points, ` +
    `${km} km of track, ${Object.keys(out.stations).length} stations, ${(json.length / 1e6).toFixed(1)} MB`,
)
