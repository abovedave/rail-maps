// Simplifies knots topo leaves in the line graph, where tracks split apart
// for a short way further than topo merges (twin tunnels at a junction, fast
// and slow lines in separate tunnels, flyovers), so they'd be drawn as loops,
// lines running apart and back together, or tangles of junctions:
//
// - junctions joined by a short track become one junction, and so do a
//   station's stops (its platforms)
// - of short ways of about the same length between the same two points, the
//   shortest is kept, carrying all their lines
// - short ways back to where they started are removed
// - station-free bypasses are removed: a way between two junctions or
//   stations, with no stations along it (ways end at stations), whose lines
//   all also run on another route between its ends that's close by and
//   about as long (the Redhill avoiding line, or fast lines splitting from
//   slow for a few kilometres), so lines are drawn once, along the route
//   with the stations
//
// repeated until none changes anything. Then, given the services (routes.json
// and linegraph.json, from linegraph.ts), turn restrictions topo inferred
// that a service shows are wrong are lifted: where a service's line can't get
// from one stop to its next only because of them, it may along the way it
// would go (see routes.ts), so it's drawn as one line, unbroken.
//
//   node src/tidy.ts topo.json stations.json [routes.json linegraph.json] > tidy.json
//
// stations.json is which station each stop is (from linegraph.ts).

import { readFileSync } from 'node:fs'
import {
  type Coord, type EdgeFeature, type Line, type NodeFeature, type TurnBan, type Way,
  edgeLength, edgesByNode, isNode, length, lineIds, other, pathLength, pushTo, readGraph, readStationKeys, search, segmentDistance,
  stationKey, waysBetween,
} from './graph.ts'
import { services, type Route } from './routes.ts'

/** Junctions joined by a track shorter than this, in metres, become one. */
const MIN_TRACK = 200
/** A station's stops linked by track shorter than this, in metres,
 *  become one; at a terminus, stops where lines end, up to
 *  MAX_TERMINUS_LINK, out through its throat and back in (Liverpool
 *  Street's Overground and National Rail platforms), so its lines run in
 *  together and end side by side rather than peeling off one by one. */
const MAX_STOP_LINK = 400
const MAX_TERMINUS_LINK = 1500
/** How far along a track, in metres, a junction's move eases out, so lines
 *  bend smoothly into where it's moved to. */
const EASE = 300
/** Ways between the same points are merged if they're all shorter than
 *  this, in metres, and none is more than LENGTH_RATIO times another. */
const MAX_LENGTH = 2000
const LENGTH_RATIO = 1.5
/** A station-free way is a bypass, and removed, if it's at least
 *  MIN_BYPASS metres long, and its lines all run on another route between
 *  its ends that's never more than BYPASS_APART metres from it, and neither
 *  is more than BYPASS_RATIO times as long as the other. */
const MIN_BYPASS = 500
const BYPASS_APART = 500
const BYPASS_RATIO = 1.3

// MARK: The graph, changed in place

const [graphFile, stationsFile, routesFile, linegraphFile] = process.argv.slice(2)
const graph = readGraph(graphFile)
const keys = readStationKeys(stationsFile)
const nodes = new Map<string, NodeFeature>()
let edges: EdgeFeature[] = []
for (const f of graph.features) isNode(f) ? nodes.set(f.properties.id, f) : edges.push(f)

let edgesAt = new Map<string, EdgeFeature[]>()
const index = () => { edgesAt = edgesByNode(edges) }

const node = (id: string) => nodes.get(id)!
const isStation = (n: string) => Boolean(nodes.get(n)?.properties.station_id)
/** A node where ways start and end: a junction, an end of a line, or a station. */
const isEnd = (n: string) => edgesAt.get(n)?.length !== 2 || isStation(n)
const linesKey = (e: EdgeFeature) => lineIds(e).sort().join('|')
const banned = (bans: TurnBan[] | undefined, line: string, a: string, b: string) => (bans ?? []).some((c) =>
  c.line === line && ((c.node_from === a && c.node_to === b) || (c.node_from === b && c.node_to === a)))
/** Whether a line can go between two neighbours through a junction. */
const allowed = (n: string, line: string, x: string, y: string) => !banned(node(n).properties.excluded_conn, line, x, y)

// MARK: Joining nodes

/** A line with its start moved, the move easing out along it over EASE (or
 *  most of the line, if shorter), with points added so the bend is smooth. */
function moveStart(c: Coord[], to: Coord): Coord[] {
  const [dx, dy] = [to[0] - c[0][0], to[1] - c[0][1]]
  const ease = Math.min(EASE, length(c) * 0.9)
  if (!ease) return [[to[0], to[1]], ...c.slice(1)]
  // Points every 20 m over the eased part
  const dense: Coord[] = [c[0]]
  for (let i = 1; i < c.length; i++) {
    const steps = Math.min(50, Math.ceil(length([c[i - 1], c[i]]) / 20))
    for (let k = 1; k <= steps; k++) {
      dense.push([c[i - 1][0] + ((c[i][0] - c[i - 1][0]) * k) / steps, c[i - 1][1] + ((c[i][1] - c[i - 1][1]) * k) / steps])
    }
  }
  let along = 0
  return dense.map((p, i) => {
    if (i) along += length([dense[i - 1], p])
    const weight = along >= ease ? 0 : (1 + Math.cos((Math.PI * along) / ease)) / 2
    return [p[0] + dx * weight, p[1] + dy * weight]
  })
}

/** The turn restrictions of junctions a and b joined into one, by the track
 *  between them: a line can go between two of their tracks only as it
 *  could before, at the same junction, or from one to the other along a
 *  track joining them. */
function joinedRestrictions(a: string, b: string): TurnBan[] {
  const links = edgesAt.get(a)!.filter((x) => other(x, a) === b)
  const linkLines = new Set(links.flatMap(lineIds))
  const tracks = [a, b]
    .flatMap((at) => edgesAt.get(at)!.filter((x) => !links.includes(x)).map((x) => ({ at, to: other(x, at), lines: new Set(lineIds(x)) })))
    .filter((t) => t.to !== a && t.to !== b)
  // Restrictions name neighbours, not tracks, so a turn between two is
  // allowed if it was along any of the tracks to them
  const turns = new Map<string, { line: string; from: string; to: string; ok: boolean }>()
  for (const [i, p] of tracks.entries()) {
    for (const q of tracks.slice(i + 1)) {
      if (p.to === q.to) continue
      for (const line of p.lines) {
        if (!q.lines.has(line)) continue
        const ok = p.at === q.at
          ? allowed(p.at, line, p.to, q.to)
          : linkLines.has(line) && allowed(p.at, line, p.to, q.at) && allowed(q.at, line, p.at, q.to)
        const key = [line, ...[p.to, q.to].sort()].join(' ')
        const turn = turns.get(key)
        if (turn) turn.ok ||= ok
        else turns.set(key, { line, from: p.to, to: q.to, ok })
      }
    }
  }
  return [...turns.values()].filter((t) => !t.ok)
    .flatMap(({ line, from, to }) => [{ line, node_from: from, node_to: to }, { line, node_from: to, node_to: from }])
}

/** Joins node b into node a along the track e between them, a moving to
 *  `at`, the tracks meeting either easing into where it's moved to. */
function join(e: EdgeFeature, a: string, b: string, at: Coord) {
  const bans = joinedRestrictions(a, b)
  // A line calls at stops joined into one if it called at either
  if (isStation(a) && isStation(b)) {
    const calling = (n: string) => {
      const not = new Set(node(n).properties.not_serving ?? [])
      return edgesAt.get(n)!.flatMap(lineIds).filter((l) => !not.has(l))
    }
    const calls = new Set([...calling(a), ...calling(b)])
    const not = [...new Set([...(node(a).properties.not_serving ?? []), ...(node(b).properties.not_serving ?? [])])].filter((l) => !calls.has(l))
    if (not.length) node(a).properties.not_serving = not
    else delete node(a).properties.not_serving
  }
  node(a).geometry.coordinates = at
  edges = edges.filter((x) => x !== e)
  for (const x of edges) {
    for (const end of ['from', 'to'] as const) {
      if (x.properties[end] === b) x.properties[end] = a
      if (x.properties[end] === a) {
        const c = x.geometry.coordinates
        x.geometry.coordinates = end === 'from' ? moveStart(c, at) : moveStart([...c].reverse(), at).reverse()
      }
    }
  }
  node(a).properties.excluded_conn = bans
  nodes.delete(b)
  for (const n of nodes.values()) {
    for (const c of n.properties.excluded_conn ?? []) {
      if (c.node_from === b) c.node_from = a
      if (c.node_to === b) c.node_to = a
    }
  }
  edges = edges.filter((x) => x.properties.from !== x.properties.to)
  index()
}

/** Joins junctions linked by a track shorter than MIN_TRACK into one, at
 *  their middle. Stations are left where they are. */
function joinJunctions() {
  let joined = 0
  for (const e of [...edges].sort((x, y) => edgeLength(x) - edgeLength(y))) {
    const { from: a, to: b } = e.properties
    if (a === b || !edgesAt.get(a)?.includes(e)) continue
    if (isStation(a) || isStation(b) || edgesAt.get(a)!.length < 3 || edgesAt.get(b)!.length < 3) continue
    if (edgeLength(e) >= MIN_TRACK) break
    const [ax, ay] = node(a).geometry.coordinates, [bx, by] = node(b).geometry.coordinates
    join(e, a, b, [(ax + bx) / 2, (ay + by) / 2])
    joined++
  }
  return joined
}

/** Joins a station's stops (see stationGroups.ts) linked by track shorter than MAX_STOP_LINK
 *  (directly, or through junctions but no other station) into one, where
 *  the stop with the most lines is, joining the junctions between into it
 *  too: platforms topo leaves apart (it no longer merges stops by name, see
 *  topo.ts), which would be drawn as loops (Euston) or a chain of the same
 *  station (St Pancras). Stops not linked by track (Whitechapel's Elizabeth
 *  line, deep under the Overground's) are left apart. */
function joinStops() {
  const station = (n: string) => stationKey(keys, node(n))
  const lineCount = (n: string) => new Set(edgesAt.get(n)!.flatMap(lineIds)).size
  /** Where lines end: a stop with one track. */
  const isTerminus = (n: string) => edgesAt.get(n)?.length === 1
  /** The track from a stop to the nearest other stop of its station, within
   *  MAX_STOP_LINK (MAX_TERMINUS_LINK between termini), through junctions
   *  only. */
  const link = (start: string) => {
    const limit = isTerminus(start) ? MAX_TERMINUS_LINK : MAX_STOP_LINK
    return search(start, edgesAt, (at, distance) => {
      if (distance >= limit) return 'give up'
      if (at === start || !isStation(at)) return 'go on'
      if (station(at) !== station(start)) return 'pass'
      if (distance >= MAX_STOP_LINK && !isTerminus(at)) return 'pass'
      return 'found'
    })
  }
  let joined = 0
  for (let found = true; found;) {
    found = false
    // Nearest first, so a station comes together where most of its
    // platforms are
    const pairs = [...edgesAt.keys()].filter(isStation)
      .map((stop) => ({ stop, linked: link(stop) }))
      .filter((p) => p.linked)
      .sort((x, y) => pathLength(x.linked!.path) - pathLength(y.linked!.path))
    for (const { stop } of pairs) {
      if (!edgesAt.has(stop)) continue
      const linked = link(stop)
      if (!linked) continue
      // Into the stop with the most lines, along the track between
      const [keep, path] = lineCount(stop) >= lineCount(linked.node) ? [stop, linked.path] : [linked.node, [...linked.path].reverse()]
      const at = node(keep).geometry.coordinates
      for (const e of path) {
        if (!edges.includes(e)) continue
        const { from, to } = e.properties
        if (from === to) continue
        join(e, keep, from === keep ? to : from, at)
      }
      joined++
      found = true
    }
  }
  return joined
}

// MARK: Merging parallel ways

type LinedWay = Way & { lines: Line[] }

/** The turn restrictions at one end of ways merged into `kept`: each line
 *  can turn from it as it could from any of them. */
function carryTurns(end: string, kept: LinedWay, merged: LinedWay[]) {
  const bans = nodes.get(end)?.properties.excluded_conn
  if (!bans) return
  /** The way's next node from this end. */
  const next = (way: Way) => other(way.edges.find((e) => e.properties.from === end || e.properties.to === end)!, end)
  const k = next(kept)
  const has = (way: LinedWay, line: string) => way.lines.some((l) => l.id === line)
  const carried: TurnBan[] = []
  for (const c of bans) {
    const x = c.node_from === k ? c.node_to : c.node_to === k ? c.node_from : undefined
    // A line kept from turning off `kept` can if it could from a merged way
    if (x !== undefined && merged.some((way) => has(way, c.line) && !banned(bans, c.line, next(way), x))) continue
    carried.push(c)
  }
  // A line new to `kept` can't turn where it couldn't from its merged ways
  for (const way of merged) {
    const d = next(way)
    for (const c of bans) {
      if (has(kept, c.line) || (c.node_from !== d && c.node_to !== d)) continue
      carried.push({ ...c, node_from: c.node_from === d ? k : c.node_from, node_to: c.node_to === d ? k : c.node_to })
    }
  }
  node(end).properties.excluded_conn = carried
}

/** Of short ways of about the same length between the same two points,
 *  keeps the shortest, carrying all their lines. Removes short loops. */
function mergeParallel() {
  const byEnds = new Map<string, LinedWay[]>()
  const loops: Way[] = []
  for (const way of waysBetween(edgesAt, isEnd)) {
    const [start, end] = way.ends
    if (start === end) {
      if (way.length <= MAX_LENGTH) loops.push(way)
      continue
    }
    if (new Set(way.edges.map(linesKey)).size !== 1) continue
    const key = [start, end].sort().join(' ')
    pushTo(byEnds, key, { ...way, lines: way.edges[0].properties.lines })
  }
  const merges = [...byEnds.values()].filter((group) => group.length > 1
    && Math.max(...group.map((w) => w.length)) <= Math.min(MAX_LENGTH, Math.min(...group.map((w) => w.length)) * LENGTH_RATIO))
  const dropped = new Set<EdgeFeature>()
  for (const group of merges) {
    group.sort((x, y) => x.length - y.length)
    const [kept, ...rest] = group
    const lines = new Map<string, Line>()
    for (const way of group) for (const l of way.lines) lines.set(l.id, l)
    for (const end of kept.ends) carryTurns(end, kept, rest)
    for (const e of kept.edges) e.properties.lines = [...lines.values()]
    for (const way of rest) {
      for (const e of way.edges) dropped.add(e)
      for (const n of way.inner) nodes.delete(n)
    }
  }
  for (const loop of loops) {
    for (const e of loop.edges) dropped.add(e)
    for (const n of loop.inner) nodes.delete(n)
  }
  edges = edges.filter((e) => !dropped.has(e))
  index()
  return merges.length + loops.length
}

// MARK: Removing bypasses

/** Metres east and north near a point, for how far apart two routes are. */
const flat = ([lon, lat]: Coord) => [lon * 111_320 * Math.cos((lat * Math.PI) / 180), lat * 110_540]

/** The shortest route between a way's ends, not along it, on track that
 *  carries all its lines, if it's about as long and close by all along. */
function alternative(way: Way) {
  const [a, b] = way.ends
  const lines = [...new Set(way.edges.flatMap(lineIds))]
  const carries = (e: EdgeFeature) => !way.edges.includes(e) && lines.every((id) => lineIds(e).includes(id))
  const longest = way.length * BYPASS_RATIO
  const found = search(a, edgesAt, (at, distance) => (at === b ? 'found' : distance > longest ? 'give up' : 'go on'), carries)
  if (!found || found.distance > longest || found.distance * BYPASS_RATIO < way.length) return
  const route = [...found.path].reverse()
  const segments = route.flatMap((e) => {
    const c = e.geometry.coordinates.map(flat)
    return c.slice(1).map((q, i) => [c[i], q])
  })
  const near = (point: Coord) => segments.some(([s, t]) => segmentDistance(flat(point), s, t) <= BYPASS_APART)
  if (!way.edges.every((e) => e.geometry.coordinates.every(near))) return
  return { length: found.distance, stations: route.flatMap((e) => [e.properties.from, e.properties.to]).filter(isStation) }
}

/** Removes station-free bypasses (see the top of this file), the longest
 *  first, one at a time, so of two that are each other's alternative only
 *  one goes. Logs each one removed. */
function dropBypasses() {
  let dropped = 0
  for (;;) {
    const bypasses = waysBetween(edgesAt, isEnd)
      .filter((w) => w.ends[0] !== w.ends[1] && w.length >= MIN_BYPASS)
      .sort((x, y) => y.length - x.length)
    let way: Way | undefined, alt: ReturnType<typeof alternative>
    for (const w of bypasses) if ((alt = alternative(w))) { way = w; break }
    if (!way || !alt) break
    const [lon, lat] = way.edges[Math.floor(way.edges.length / 2)].geometry.coordinates[0]
    const names = [...new Set(alt.stations.map((n) => node(n).properties.station_label))]
    const lines = [...new Set(way.edges.flatMap(lineIds))]
    console.error(`  bypass at ${lat.toFixed(4)},${lon.toFixed(4)}: ${Math.round(way.length)} m, removed for ${Math.round(alt.length)} m${names.length ? ` via ${names.join(', ')}` : ''} (${lines.join(', ')})`)
    edges = edges.filter((e) => !way.edges.includes(e))
    for (const n of way.inner) nodes.delete(n)
    index()
    dropped++
  }
  return dropped
}

// MARK: Run

index()
let joined = 0, stops = 0, merged = 0, bypasses = 0
for (let round = 0; round < 10; round++) {
  const s = joinStops(), j = joinJunctions(), m = mergeParallel(), b = dropBypasses()
  stops += s
  joined += j
  merged += m
  bypasses += b
  if (!s && !j && !m && !b) break
}

// Turn restrictions only between nodes still next to each other, and none
// where only two tracks meet: a line on both runs on through (as track
// does), or loom orders it differently either side and it's drawn broken
// (Caledonian Road & Barnsbury, where tidying left a junction with two)
let unblocked = 0
const kept = [...nodes.values()].filter((n) => edgesAt.has(n.properties.id)).map((n) => {
  const near = new Set(edgesAt.get(n.properties.id)!.map((e) => other(e, n.properties.id)))
  const through = edgesAt.get(n.properties.id)!.length === 2
  if (through && n.properties.excluded_conn?.length) unblocked++
  const bans = n.properties.excluded_conn?.filter((c) => !through && near.has(c.node_from) && near.has(c.node_to))
  return bans ? { ...n, properties: { ...n.properties, excluded_conn: bans } } : n
})

// Turns services make that topo didn't allow
let lifted = 0
if (routesFile && linegraphFile) {
  const routes: Route[] = JSON.parse(readFileSync(routesFile, 'utf8'))
  const { nodes: byId, runs, way } = services([...kept, ...edges], readGraph(linegraphFile).features, keys)
  for (const run of runs(routes).runs) {
    if (way(run)) continue
    const turns = way(run, true)
    if (!turns) continue
    const line = run.route.line
    for (let i = 1; i < turns.length - 1; i++) {
      const n = byId.get(turns[i])!
      const before = n.properties.excluded_conn?.length ?? 0
      n.properties.excluded_conn = n.properties.excluded_conn?.filter((c) => !banned([c], line, turns[i - 1], turns[i + 1]))
      if ((n.properties.excluded_conn?.length ?? 0) < before) lifted++
    }
  }
}

console.error(`Joined ${stops} pairs of stops and ${joined} of junctions, merged ${merged} sets of parallel ways, removed ${bypasses} bypasses, let lines run on through ${unblocked} nodes of two tracks, lifted ${lifted} turn restrictions services make`)
process.stdout.write(JSON.stringify({ ...graph, features: [...kept, ...edges] }))
