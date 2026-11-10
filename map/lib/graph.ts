// The line graph that topo, tidy and loom read and write (GeoJSON), and the
// graph helpers the build steps share.
//
// Nodes are `Point` features, stations among them (`station_id`,
// `station_label`); edges are `LineString` features from one node to
// another, listing the lines on them. LOOM adds turn restrictions to nodes
// (`excluded_conn`: a line can't go between two neighbours through it).

import { readFileSync } from 'node:fs'

/** [longitude, latitude]. */
export type Coord = [number, number]

export interface Line { id: string; label: string; color: string }

/** A line can't go from one neighbour of a node to another through it. */
export interface TurnBan { line: string; node_from: string; node_to: string }

export interface NodeFeature {
  type: 'Feature'
  geometry: { type: 'Point'; coordinates: Coord }
  properties: {
    id: string
    station_id?: string
    station_label?: string
    excluded_conn?: TurnBan[]
    /** Lines passing through a station without calling. */
    not_serving?: string[]
    [key: string]: unknown
  }
}

export interface EdgeFeature {
  type: 'Feature'
  geometry: { type: 'LineString'; coordinates: Coord[] }
  properties: { id?: string; from: string; to: string; lines: Line[]; [key: string]: unknown }
}

export type Feature = NodeFeature | EdgeFeature
export interface Graph { type: 'FeatureCollection'; features: Feature[]; [key: string]: unknown }

export const isNode = (f: Feature): f is NodeFeature => f.geometry.type === 'Point'
export const isEdge = (f: Feature): f is EdgeFeature => f.geometry.type === 'LineString'

export const readGraph = (path: string): Graph => JSON.parse(readFileSync(path, 'utf8'))

/** Which station each stop is, by station_id (stations.json, from
 *  linegraph.ts): the same key for all of a station's stops. */
export type StationKeys = Map<string, string>
export const readStationKeys = (path: string): StationKeys => new Map(Object.entries(JSON.parse(readFileSync(path, 'utf8'))))
/** A station node's key: its stop's, or else its name. */
export const stationKey = (keys: StationKeys, n: NodeFeature) =>
  (n.properties.station_id && keys.get(n.properties.station_id)) || `name:${n.properties.station_label}`

/** Adds a value to the list at a key, making the list if needed. */
export function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

/** The node at an edge's other end. */
export const other = (e: EdgeFeature, node: string) => (e.properties.from === node ? e.properties.to : e.properties.from)

/** An edge's lines' ids. */
export const lineIds = (e: EdgeFeature) => e.properties.lines.map((l) => l.id)

/** Each node's edges, in the order given. */
export function edgesByNode(edges: EdgeFeature[]) {
  const at = new Map<string, EdgeFeature[]>()
  for (const e of edges) for (const n of [e.properties.from, e.properties.to]) pushTo(at, n, e)
  return at
}

/** A line's length in metres, near enough over short distances. */
export function length(c: Coord[]) {
  let total = 0
  for (let i = 1; i < c.length; i++) {
    const lat = ((c[i][1] + c[i - 1][1]) / 2) * (Math.PI / 180)
    total += Math.hypot((c[i][0] - c[i - 1][0]) * Math.cos(lat), c[i][1] - c[i - 1][1]) * 111_320
  }
  return total
}
export const edgeLength = (e: EdgeFeature) => length(e.geometry.coordinates)
export const pathLength = (path: EdgeFeature[]) => path.reduce((sum, e) => sum + edgeLength(e), 0)

/** A way: a run of edges from one end to another through nodes of two
 *  edges, which `isEnd` doesn't count as ends. A loop ends where it starts. */
export interface Way { ends: [string, string]; edges: EdgeFeature[]; inner: string[]; length: number }

/** Every way between ends (as `isEnd` decides), each once. */
export function waysBetween(edgesAt: Map<string, EdgeFeature[]>, isEnd: (node: string) => boolean): Way[] {
  const ways: Way[] = []
  const walked = new Set<EdgeFeature>()
  for (const [start, startEdges] of edgesAt) {
    if (!isEnd(start)) continue
    for (const first of startEdges) {
      if (walked.has(first)) continue
      const edges = [first], inner: string[] = []
      let at = other(first, start)
      while (!isEnd(at) && at !== start) {
        inner.push(at)
        const next = edgesAt.get(at)!.find((e) => e !== edges[edges.length - 1])!
        edges.push(next)
        at = other(next, at)
      }
      for (const e of edges) walked.add(e)
      ways.push({ ends: [start, at], edges, inner, length: pathLength(edges) })
    }
  }
  return ways
}

/** What a search does at the nearest node it hasn't been to: stop there
 *  (found), give up, pass over it (not going on from it), or go on. */
export type Visit = 'found' | 'give up' | 'pass' | 'go on'

/** Dijkstra over track length from `start`, along edges `follow` allows,
 *  asking `visit` at each node, nearest first. The node found, how far it
 *  is, and the edges from `start` to it; undefined if none is. */
export function search(
  start: string,
  edgesAt: Map<string, EdgeFeature[]>,
  visit: (node: string, distance: number) => Visit,
  follow: (e: EdgeFeature) => boolean = () => true,
) {
  const distance = new Map([[start, 0]]), via = new Map<string, EdgeFeature>(), done = new Set<string>()
  for (;;) {
    let at: string | undefined, best = Infinity
    for (const [n, d] of distance) if (!done.has(n) && d < best) [at, best] = [n, d]
    if (at === undefined) return
    const action = visit(at, best)
    if (action === 'give up') return
    if (action === 'found') {
      const path: EdgeFeature[] = []
      for (let n = at; n !== start;) { const e = via.get(n)!; path.unshift(e); n = other(e, n) }
      return { node: at, distance: best, path }
    }
    done.add(at)
    if (action === 'pass') continue
    for (const e of edgesAt.get(at) ?? []) {
      if (!follow(e)) continue
      const n = other(e, at), d = best + edgeLength(e)
      if (n !== at && d < (distance.get(n) ?? Infinity)) { distance.set(n, d); via.set(n, e) }
    }
  }
}

/** Distance from a point to the segment a–b, in the points' units. */
export function segmentDistance(p: number[], a: number[], b: number[]) {
  const dx = b[0] - a[0], dy = b[1] - a[1], length2 = dx * dx + dy * dy
  const t = length2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2)) : 0
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
}
