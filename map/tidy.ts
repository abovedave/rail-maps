// Tidies the knots topo leaves in the line graph before loom orders the
// lines. Topo merges parallel track only so far apart, so where tracks split
// for a short way (twin tunnels at a junction, fast and slow lines in
// separate tunnels, flyovers) they'd be drawn as loops, lines running apart
// and back together, or tangles of junctions. Four passes, repeated until
// none changes anything:
//
// 1. Join stops: a station's stops (its platforms) linked by a short track
//    become one node.
// 2. Join junctions: junctions linked by a short track become one.
// 3. Merge parallel ways: of short ways about as long between the same two
//    nodes, the shortest is kept, carrying all their lines; short loops
//    back to where they started go.
// 4. Drop bypasses: a way with no stations whose lines all also run on a
//    route with stations close by and about as long (the Redhill avoiding
//    line, fast lines splitting from slow for a few kilometres) goes, so
//    its lines are drawn once, through the stations.
//
// Then turn restrictions are cleaned up: topo infers which turns a line
// can't make at each junction (LOOM's `excluded_conn`, here "bans"), and
// joining and merging moves them about. Bans between nodes no longer next
// to each other go, and so do bans a service shows are wrong, where it
// couldn't otherwise get from one stop to the next (see routes.ts), so it's
// drawn as one unbroken line.
//
//   node map/tidy.ts topo.json stations.json [routes.json linegraph.json] > tidy.json
//
// stations.json is which station each stop is; routes.json and
// linegraph.json are the services and where their stops were (all from
// linegraph.ts).

import { readFileSync } from 'node:fs'
import {
  type Coord, type EdgeFeature, type Feature, type Line, type NodeFeature, type TurnBan, type Way,
  edgeLength, edgesByNode, isNode, length, lineIds, other, pathLength, pushTo, readGraph, readStationKeys, search, segmentDistance,
  stationKey, waysBetween,
} from './lib/graph.ts'
import { services, type Route } from './lib/routes.ts'

// All distances are in metres along the track, unless they say otherwise.

/** 1. A station's stops are joined if linked by less track than this; at a
 *  terminus (a stop where lines end), by up to TERMINUS_STOPS_WITHIN, out
 *  through its throat and back in (Liverpool Street's Overground and
 *  National Rail platforms), so its lines run in together and end side by
 *  side rather than peeling off one by one. */
const STOPS_WITHIN = 400
const TERMINUS_STOPS_WITHIN = 1500
/** 2. Junctions are joined if linked by less track than this. */
const JUNCTIONS_WITHIN = 200
/** 1 and 2. When a node moves, the tracks into it bend to meet it over
 *  this far, so lines curve smoothly into where it's moved to. */
const EASE_OVER = 300
/** 3. Ways between the same two nodes are merged if all are shorter than
 *  this, and none is more than PARALLEL_RATIO times as long as another. */
const PARALLEL_UP_TO = 2000
const PARALLEL_RATIO = 1.5
/** 4. A way is a bypass if it's at least BYPASS_FROM long, and another
 *  route carrying all its lines is never more than BYPASS_APART from it
 *  (straight-line metres), and neither is more than BYPASS_RATIO times as
 *  long as the other. */
const BYPASS_FROM = 500
const BYPASS_APART = 500
const BYPASS_RATIO = 1.3

// MARK: The graph, changed in place

const [graphFile, stationsFile, routesFile, linegraphFile] = process.argv.slice(2)
const graph = readGraph(graphFile)
const stationKeys = readStationKeys(stationsFile)
const nodes = new Map<string, NodeFeature>()
let edges: EdgeFeature[] = []
for (const f of graph.features) isNode(f) ? nodes.set(f.properties.id, f) : edges.push(f)

/** Each node's edges: rebuilt (`reindex`) whenever edges change. */
let edgesAt = new Map<string, EdgeFeature[]>()
const reindex = () => { edgesAt = edgesByNode(edges) }

const node = (id: string) => nodes.get(id)!
const isStation = (n: string) => Boolean(nodes.get(n)?.properties.station_id)
/** A node where ways start and end: a junction, an end of a line, or a station. */
const isEnd = (n: string) => edgesAt.get(n)?.length !== 2 || isStation(n)
/** An edge's lines, as one string, to compare edges by. */
const linesKey = (e: EdgeFeature) => lineIds(e).sort().join('|')

/** Whether bans stop a line going between neighbours a and b (either way). */
const banned = (bans: TurnBan[] | undefined, line: string, a: string, b: string) => (bans ?? []).some((ban) =>
  ban.line === line && ((ban.node_from === a && ban.node_to === b) || (ban.node_from === b && ban.node_to === a)))
/** Whether a line can go between two neighbours through a node. */
const allowed = (n: string, line: string, a: string, b: string) => !banned(node(n).properties.excluded_conn, line, a, b)

// MARK: Joining nodes (passes 1 and 2)

/** A line with its start moved to `to`, the move easing out along it over
 *  EASE_OVER (or most of the line, if shorter), with points added every
 *  20 m so the bend is smooth. */
function moveStart(c: Coord[], to: Coord): Coord[] {
  const [dx, dy] = [to[0] - c[0][0], to[1] - c[0][1]]
  const ease = Math.min(EASE_OVER, length(c) * 0.9)
  if (!ease) return [[to[0], to[1]], ...c.slice(1)]
  const dense: Coord[] = [c[0]]
  for (let i = 1; i < c.length; i++) {
    const steps = Math.min(50, Math.ceil(length([c[i - 1], c[i]]) / 20))
    for (let k = 1; k <= steps; k++) {
      dense.push([c[i - 1][0] + ((c[i][0] - c[i - 1][0]) * k) / steps, c[i - 1][1] + ((c[i][1] - c[i - 1][1]) * k) / steps])
    }
  }
  // Fully moved at the start, not at all from `ease` on, a cosine between
  let along = 0
  return dense.map((p, i) => {
    if (i) along += length([dense[i - 1], p])
    const weight = along >= ease ? 0 : (1 + Math.cos((Math.PI * along) / ease)) / 2
    return [p[0] + dx * weight, p[1] + dy * weight]
  })
}

/** The bans for nodes a and b joined into one. Each node's tracks go on to
 *  other neighbours; joined, a line can go from one of those tracks to
 *  another only if it could before: through the same node, or through
 *  one, along a track linking a and b, and through the other. Bans name
 *  neighbours, not tracks, so a turn to a neighbour is allowed if it was
 *  along any track to it. */
function joinedBans(a: string, b: string): TurnBan[] {
  const links = edgesAt.get(a)!.filter((e) => other(e, a) === b)
  const linkLines = new Set(links.flatMap(lineIds))
  /** Each track out from a or b, other than to each other: where it starts,
   *  the neighbour it goes to, and its lines. */
  const tracks = [a, b]
    .flatMap((at) => edgesAt.get(at)!.filter((e) => !links.includes(e)).map((e) => ({ at, to: other(e, at), lines: new Set(lineIds(e)) })))
    .filter((t) => t.to !== a && t.to !== b)
  /** Each line's turn between two neighbours, and whether any track allows it. */
  const turns = new Map<string, { line: string; from: string; to: string; ok: boolean }>()
  for (const [i, x] of tracks.entries()) {
    for (const y of tracks.slice(i + 1)) {
      if (x.to === y.to) continue
      for (const line of x.lines) {
        if (!y.lines.has(line)) continue
        const ok = x.at === y.at
          ? allowed(x.at, line, x.to, y.to)
          : linkLines.has(line) && allowed(x.at, line, x.to, y.at) && allowed(y.at, line, x.at, y.to)
        const key = [line, ...[x.to, y.to].sort()].join(' ')
        const turn = turns.get(key)
        if (turn) turn.ok ||= ok
        else turns.set(key, { line, from: x.to, to: y.to, ok })
      }
    }
  }
  return [...turns.values()].filter((t) => !t.ok)
    .flatMap(({ line, from, to }) => [{ line, node_from: from, node_to: to }, { line, node_from: to, node_to: from }])
}

/** The lines that pass stops a and b, joined into one, without calling: a
 *  line calls at the joined stop if it called at either. */
function joinedNotServing(a: string, b: string) {
  const calling = (n: string) => {
    const not = new Set(node(n).properties.not_serving ?? [])
    return edgesAt.get(n)!.flatMap(lineIds).filter((l) => !not.has(l))
  }
  const calls = new Set([...calling(a), ...calling(b)])
  return [...new Set([...(node(a).properties.not_serving ?? []), ...(node(b).properties.not_serving ?? [])])].filter((l) => !calls.has(l))
}

/** Joins node b into node a, removing the track e between them: a moves
 *  to `at`, b's tracks become a's, and every track into a bends to meet it. */
function join(e: EdgeFeature, a: string, b: string, at: Coord) {
  const bans = joinedBans(a, b)
  if (isStation(a) && isStation(b)) {
    const not = joinedNotServing(a, b)
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
  // Other nodes' bans naming b now name a
  nodes.delete(b)
  for (const n of nodes.values()) {
    for (const ban of n.properties.excluded_conn ?? []) {
      if (ban.node_from === b) ban.node_from = a
      if (ban.node_to === b) ban.node_to = a
    }
  }
  // Other tracks between a and b are now loops on a
  edges = edges.filter((x) => x.properties.from !== x.properties.to)
  reindex()
}

/** 1. Joins each station's stops (see stationGroups.ts) linked by track
 *  within STOPS_WITHIN (TERMINUS_STOPS_WITHIN between termini), directly or
 *  through junctions but no other station, into the one with the most
 *  lines, the junctions between too. These are platforms topo leaves apart
 *  (it doesn't join stops, see topo.ts), which would be drawn as loops
 *  (Euston) or a chain of the same station (St Pancras). Stops not linked
 *  by track (Whitechapel's Elizabeth line, deep under the Overground's)
 *  stay apart. Returns how many were joined. */
function joinStops() {
  const station = (n: string) => stationKey(stationKeys, node(n))
  const lineCount = (n: string) => new Set(edgesAt.get(n)!.flatMap(lineIds)).size
  const isTerminus = (n: string) => edgesAt.get(n)?.length === 1
  /** The track from a stop to the nearest other stop of its station in
   *  reach, if any. */
  const link = (start: string) => {
    const reach = isTerminus(start) ? TERMINUS_STOPS_WITHIN : STOPS_WITHIN
    return search(start, edgesAt, (at, distance) => {
      if (distance >= reach) return 'give up'
      if (at === start || !isStation(at)) return 'go on'
      // Not through other stations
      if (station(at) !== station(start)) return 'pass'
      // Only termini are joined further apart
      if (distance >= STOPS_WITHIN && !isTerminus(at)) return 'pass'
      return 'found'
    })
  }
  let joined = 0
  for (let changed = true; changed;) {
    changed = false
    // Nearest first, so a station comes together where most of its
    // platforms are
    const linked = [...edgesAt.keys()].filter(isStation)
      .map((stop) => ({ stop, link: link(stop) }))
      .filter((s) => s.link)
      .sort((x, y) => pathLength(x.link!.path) - pathLength(y.link!.path))
    for (const { stop } of linked) {
      // Earlier joins may have joined it, or moved its link
      if (!edgesAt.has(stop)) continue
      const found = link(stop)
      if (!found) continue
      const [keep, path] = lineCount(stop) >= lineCount(found.node) ? [stop, found.path] : [found.node, [...found.path].reverse()]
      const at = node(keep).geometry.coordinates
      // Along the track, each node in turn into the one kept
      for (const e of path) {
        if (!edges.includes(e)) continue
        const { from, to } = e.properties
        if (from === to) continue
        join(e, keep, from === keep ? to : from, at)
      }
      joined++
      changed = true
    }
  }
  return joined
}

/** 2. Joins junctions linked by track shorter than JUNCTIONS_WITHIN, the
 *  shortest first, at their middle. Stations stay where they are. Returns
 *  how many were joined. */
function joinJunctions() {
  let joined = 0
  for (const e of [...edges].sort((x, y) => edgeLength(x) - edgeLength(y))) {
    const { from: a, to: b } = e.properties
    // Gone in an earlier join
    if (a === b || !edgesAt.get(a)?.includes(e)) continue
    if (isStation(a) || isStation(b) || edgesAt.get(a)!.length < 3 || edgesAt.get(b)!.length < 3) continue
    if (edgeLength(e) >= JUNCTIONS_WITHIN) break
    const [ax, ay] = node(a).geometry.coordinates, [bx, by] = node(b).geometry.coordinates
    join(e, a, b, [(ax + bx) / 2, (ay + by) / 2])
    joined++
  }
  return joined
}

// MARK: Merging parallel ways (pass 3)

/** A way and its lines (the same along it). */
type LinedWay = Way & { lines: Line[] }

/** The bans at one end of ways merged into `kept`: each line can turn from
 *  `kept` as it could from any of the ways it carries. */
function carryBans(end: string, kept: LinedWay, merged: LinedWay[]) {
  const bans = nodes.get(end)?.properties.excluded_conn
  if (!bans) return
  /** A way's first node from this end. */
  const nextOn = (way: Way) => other(way.edges.find((e) => e.properties.from === end || e.properties.to === end)!, end)
  const keptNext = nextOn(kept)
  const carries = (way: LinedWay, line: string) => way.lines.some((l) => l.id === line)
  const carried: TurnBan[] = []
  for (const ban of bans) {
    // A line banned from turning between `kept` and a neighbour can if it
    // could from a merged way
    const neighbour = ban.node_from === keptNext ? ban.node_to : ban.node_to === keptNext ? ban.node_from : undefined
    if (neighbour !== undefined && merged.some((way) => carries(way, ban.line) && !banned(bans, ban.line, nextOn(way), neighbour))) continue
    carried.push(ban)
  }
  // A line new to `kept` can't turn where it couldn't from its merged way
  for (const way of merged) {
    const wayNext = nextOn(way)
    for (const ban of bans) {
      if (carries(kept, ban.line) || (ban.node_from !== wayNext && ban.node_to !== wayNext)) continue
      carried.push({ ...ban, node_from: ban.node_from === wayNext ? keptNext : ban.node_from, node_to: ban.node_to === wayNext ? keptNext : ban.node_to })
    }
  }
  node(end).properties.excluded_conn = carried
}

/** 3. Of ways between the same two nodes, with the same lines all along,
 *  all within PARALLEL_UP_TO and PARALLEL_RATIO of each other, keeps the
 *  shortest, carrying all their lines. Removes loops back to where they
 *  started within PARALLEL_UP_TO. Returns how many sets were merged and
 *  loops removed. */
function mergeParallel() {
  const byEnds = new Map<string, LinedWay[]>()
  const loops: Way[] = []
  for (const way of waysBetween(edgesAt, isEnd)) {
    const [start, end] = way.ends
    if (start === end) {
      if (way.length <= PARALLEL_UP_TO) loops.push(way)
      continue
    }
    if (new Set(way.edges.map(linesKey)).size !== 1) continue
    pushTo(byEnds, [start, end].sort().join(' '), { ...way, lines: way.edges[0].properties.lines })
  }
  const sets = [...byEnds.values()].filter((ways) => ways.length > 1
    && Math.max(...ways.map((w) => w.length)) <= Math.min(PARALLEL_UP_TO, Math.min(...ways.map((w) => w.length)) * PARALLEL_RATIO))
  const dropped = new Set<EdgeFeature>()
  for (const ways of sets) {
    ways.sort((x, y) => x.length - y.length)
    const [kept, ...rest] = ways
    const lines = new Map<string, Line>()
    for (const way of ways) for (const l of way.lines) lines.set(l.id, l)
    for (const end of kept.ends) carryBans(end, kept, rest)
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
  reindex()
  return sets.length + loops.length
}

// MARK: Dropping bypasses (pass 4)

/** Metres east and north near a point, to measure how far apart two
 *  routes are. */
const flat = ([lon, lat]: Coord) => [lon * 111_320 * Math.cos((lat * Math.PI) / 180), lat * 110_540]

/** The shortest other route between a way's ends, on track carrying all
 *  its lines, if it's about as long (BYPASS_RATIO) and never further than
 *  BYPASS_APART from the way: its length, and the stations along it. */
function alternativeTo(way: Way) {
  const [a, b] = way.ends
  const lines = [...new Set(way.edges.flatMap(lineIds))]
  const carriesAll = (e: EdgeFeature) => !way.edges.includes(e) && lines.every((id) => lineIds(e).includes(id))
  const longest = way.length * BYPASS_RATIO
  const found = search(a, edgesAt, (at, distance) => (at === b ? 'found' : distance > longest ? 'give up' : 'go on'), carriesAll)
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

/** The longest bypass, and its alternative, if there is one. */
function longestBypass() {
  const ways = waysBetween(edgesAt, isEnd)
    .filter((w) => w.ends[0] !== w.ends[1] && w.length >= BYPASS_FROM)
    .sort((x, y) => y.length - x.length)
  for (const way of ways) {
    const alternative = alternativeTo(way)
    if (alternative) return { way, alternative }
  }
}

/** 4. Removes bypasses, the longest first, one at a time, so of two that
 *  are each other's alternative only one goes. Logs each one. Returns how
 *  many were removed. */
function dropBypasses() {
  let dropped = 0
  for (let found; (found = longestBypass());) {
    const { way, alternative } = found
    const [lon, lat] = way.edges[Math.floor(way.edges.length / 2)].geometry.coordinates[0]
    const names = [...new Set(alternative.stations.map((n) => node(n).properties.station_label))]
    const lines = [...new Set(way.edges.flatMap(lineIds))]
    console.error(`  bypass at ${lat.toFixed(4)},${lon.toFixed(4)}: ${Math.round(way.length)} m, removed for ${Math.round(alternative.length)} m${names.length ? ` via ${names.join(', ')}` : ''} (${lines.join(', ')})`)
    edges = edges.filter((e) => !way.edges.includes(e))
    for (const n of way.inner) nodes.delete(n)
    reindex()
    dropped++
  }
  return dropped
}

// MARK: Turn restrictions, after

/** Nodes left on the graph, with only bans between neighbours still next
 *  to them, and none where only two tracks meet: a line on both runs on
 *  through (as track does), or loom orders it differently either side and
 *  it's drawn broken (Caledonian Road & Barnsbury, where tidying left a
 *  junction with two). Returns them, and how many nodes of two tracks lost
 *  their bans. */
function cleanBans() {
  let throughNodes = 0
  const kept = [...nodes.values()].filter((n) => edgesAt.has(n.properties.id)).map((n) => {
    const neighbours = new Set(edgesAt.get(n.properties.id)!.map((e) => other(e, n.properties.id)))
    const through = edgesAt.get(n.properties.id)!.length === 2
    if (through && n.properties.excluded_conn?.length) throughNodes++
    const bans = n.properties.excluded_conn?.filter((ban) => !through && neighbours.has(ban.node_from) && neighbours.has(ban.node_to))
    return bans ? { ...n, properties: { ...n.properties, excluded_conn: bans } } : n
  })
  return { kept, throughNodes }
}

/** Lifts bans where a service's line can't get from one stop to the next
 *  only because of them, along the way it would go if it could turn
 *  anywhere. `stops` are the line graph's stops, where each was. Returns
 *  how many were lifted. */
function liftBansServicesNeed(kept: NodeFeature[], routes: Route[], stops: Feature[]) {
  let lifted = 0
  const { nodes: byId, runs, way } = services([...kept, ...edges], stops, stationKeys)
  for (const run of runs(routes).runs) {
    if (way(run)) continue
    const turns = way(run, true)
    if (!turns) continue
    const line = run.route.line
    for (let i = 1; i < turns.length - 1; i++) {
      const n = byId.get(turns[i])!
      const before = n.properties.excluded_conn?.length ?? 0
      n.properties.excluded_conn = n.properties.excluded_conn?.filter((ban) => !banned([ban], line, turns[i - 1], turns[i + 1]))
      if ((n.properties.excluded_conn?.length ?? 0) < before) lifted++
    }
  }
  return lifted
}

// MARK: Run

reindex()
// The passes, until none changes anything (at most 10 rounds)
let stops = 0, junctions = 0, parallel = 0, bypasses = 0
for (let round = 0; round < 10; round++) {
  const s = joinStops(), j = joinJunctions(), p = mergeParallel(), b = dropBypasses()
  stops += s
  junctions += j
  parallel += p
  bypasses += b
  if (!s && !j && !p && !b) break
}
const { kept, throughNodes } = cleanBans()
const lifted = routesFile && linegraphFile
  ? liftBansServicesNeed(kept, JSON.parse(readFileSync(routesFile, 'utf8')), readGraph(linegraphFile).features)
  : 0

console.error(`Joined ${stops} pairs of stops and ${junctions} of junctions, merged ${parallel} sets of parallel ways, removed ${bypasses} bypasses, let lines run on through ${throughNodes} nodes of two tracks, lifted ${lifted} turn restrictions services make`)
process.stdout.write(JSON.stringify({ ...graph, features: [...kept, ...edges] }))
