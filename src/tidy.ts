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
//   all also run on another route between its ends that's
//   close by and about as long (the Redhill avoiding line, or fast lines
//   splitting from slow for a few kilometres), so lines are drawn once, along
//   the route with the stations
//
// repeated until none changes anything. Then, given the services (routes.json
// and linegraph.json, from linegraph.ts), turn restrictions topo inferred
// that a service shows are wrong are lifted: where a service's line can't get
// from one stop to its next only because of them, it may along the way it
// would go (see routes.ts), so it's drawn as one line, unbroken.
//
//   node src/tidy.ts topo.json [routes.json linegraph.json] > tidy.json

import { readFileSync } from 'node:fs'
import { services, type Route } from './routes.ts'

/** Junctions joined by a track shorter than this, in metres, become one. */
const MIN_TRACK = 200
/** A station's stops linked by track shorter than this, in metres,
 *  become one. */
const MAX_STOP_LINK = 400
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

const graph = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const nodes = new Map<string, any>()
let edges: any[] = []
for (const f of graph.features) f.geometry.type === 'Point' ? nodes.set(f.properties.id, f) : edges.push(f)

const metres = (c: [number, number][]) => {
  let total = 0
  for (let i = 1; i < c.length; i++) {
    const lat = ((c[i][1] + c[i - 1][1]) / 2) * (Math.PI / 180)
    total += Math.hypot((c[i][0] - c[i - 1][0]) * Math.cos(lat), c[i][1] - c[i - 1][1]) * 111_320
  }
  return total
}
const linesOf = (e: any) => e.properties.lines.map((l: any) => l.id).sort().join('|')
const other = (e: any, n: string) => (e.properties.from === n ? e.properties.to : e.properties.from)
/** A line with its start moved, the move easing out along it over EASE (or
 *  most of the line, if shorter), with points added so the bend is smooth. */
function moveStart(c: [number, number][], to: number[]): [number, number][] {
  const [dx, dy] = [to[0] - c[0][0], to[1] - c[0][1]]
  const ease = Math.min(EASE, metres(c) * 0.9)
  if (!ease) return [[to[0], to[1]], ...c.slice(1)]
  // Points every 20 m over the eased part
  const dense: [number, number][] = [c[0]]
  for (let i = 1; i < c.length; i++) {
    const steps = Math.min(50, Math.ceil(metres([c[i - 1], c[i]]) / 20))
    for (let k = 1; k <= steps; k++) dense.push([c[i - 1][0] + ((c[i][0] - c[i - 1][0]) * k) / steps, c[i - 1][1] + ((c[i][1] - c[i - 1][1]) * k) / steps])
  }
  let along = 0
  return dense.map((p, i) => {
    if (i) along += metres([dense[i - 1], p])
    const weight = along >= ease ? 0 : (1 + Math.cos((Math.PI * along) / ease)) / 2
    return [p[0] + dx * weight, p[1] + dy * weight]
  })
}
const isStation = (n: string) => Boolean(nodes.get(n)?.properties.station_id)

let edgesAt = new Map<string, any[]>()
const index = () => {
  edgesAt = new Map()
  for (const e of edges) for (const n of [e.properties.from, e.properties.to]) (edgesAt.get(n) ?? edgesAt.set(n, []).get(n)!).push(e)
}

/** Whether a line can go between two neighbours through a junction. */
const allowed = (n: string, line: string, x: string, y: string) =>
  !(nodes.get(n).properties.excluded_conn ?? []).some((c: any) => c.line === line
    && ((c.node_from === x && c.node_to === y) || (c.node_from === y && c.node_to === x)))

/** The turn restrictions of junctions a and b joined into one, by the track
 *  e between them: a line can go between two of their tracks only as it
 *  could before, at the same junction, or from one to the other along e. */
function joinedRestrictions(e: any, a: string, b: string) {
  // Lines can go between them along any track joining them, not just e
  const links = edgesAt.get(a)!.filter((x) => other(x, a) === b)
  const link = new Set(links.flatMap((x) => x.properties.lines.map((l: any) => l.id)))
  const tracks = [a, b].flatMap((at) => edgesAt.get(at)!.filter((x) => !links.includes(x))
    .map((x) => ({ at, to: other(x, at), lines: new Set<string>(x.properties.lines.map((l: any) => l.id)) })))
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
          : link.has(line) && allowed(p.at, line, p.to, q.at) && allowed(q.at, line, p.at, q.to)
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
function join(e: any, a: string, b: string, at: number[]) {
  const conns = joinedRestrictions(e, a, b)
  // A line calls at stops joined into one if it called at either
  const calling = (n: string) => {
    const not = new Set<string>(nodes.get(n).properties.not_serving ?? [])
    return edgesAt.get(n)!.flatMap((x) => x.properties.lines.map((l: any) => l.id)).filter((l: string) => !not.has(l))
  }
  if (isStation(a) && isStation(b)) {
    const calls = new Set([...calling(a), ...calling(b)])
    const not = [...new Set([...(nodes.get(a).properties.not_serving ?? []), ...(nodes.get(b).properties.not_serving ?? [])])].filter((l) => !calls.has(l))
    if (not.length) nodes.get(a).properties.not_serving = not
    else delete nodes.get(a).properties.not_serving
  }
  nodes.get(a).geometry.coordinates = at
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
  nodes.get(a).properties.excluded_conn = conns
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
  for (const e of [...edges].sort((a, b) => metres(a.geometry.coordinates) - metres(b.geometry.coordinates))) {
    const { from: a, to: b } = e.properties
    if (a === b || !edgesAt.get(a)?.includes(e)) continue
    if (isStation(a) || isStation(b) || edgesAt.get(a)!.length < 3 || edgesAt.get(b)!.length < 3) continue
    if (metres(e.geometry.coordinates) >= MIN_TRACK) break
    // b becomes a, half way between them
    const [ax, ay] = nodes.get(a).geometry.coordinates, [bx, by] = nodes.get(b).geometry.coordinates
    join(e, a, b, [(ax + bx) / 2, (ay + by) / 2])
    joined++
  }
  return joined
}

/** Joins a station's stops linked by track shorter than MAX_STOP_LINK
 *  (directly, or through junctions but no other station) into one, where
 *  the stop with the most lines is, joining the junctions between into it
 *  too: platforms topo leaves apart (it no longer merges stops by name, see
 *  topo.ts), which would be drawn as loops (Euston) or a chain of the same
 *  station (St Pancras). Stops not linked by track (Whitechapel's Elizabeth
 *  line, deep under the Overground's) are left apart. */
function joinStops() {
  const name = (n: string) => nodes.get(n)?.properties.station_label
  const lines = (n: string) => new Set(edgesAt.get(n)!.flatMap((x) => x.properties.lines.map((l: any) => l.id))).size
  /** The track from a stop to the nearest other stop of its name, within
   *  MAX_STOP_LINK, through junctions only. */
  function link(start: string): { to: string; path: any[] } | undefined {
    const distance = new Map([[start, 0]]), via = new Map<string, any>(), settled = new Set<string>()
    for (;;) {
      let at: string | undefined, best = Infinity
      for (const [n, d] of distance) if (!settled.has(n) && d < best) [at, best] = [n, d]
      if (at === undefined || best >= MAX_STOP_LINK) return
      settled.add(at)
      if (at !== start && isStation(at)) {
        if (name(at) !== name(start)) continue
        const path: any[] = []
        for (let n = at; n !== start;) { const e = via.get(n); path.unshift(e); n = other(e, n) }
        return { to: at, path }
      }
      for (const e of edgesAt.get(at) ?? []) {
        const n = other(e, at), d = best + metres(e.geometry.coordinates)
        if (n !== at && d < (distance.get(n) ?? Infinity)) { distance.set(n, d); via.set(n, e) }
      }
    }
  }
  const length = (path: any[]) => path.reduce((sum, e) => sum + metres(e.geometry.coordinates), 0)
  let joined = 0
  for (let found = true; found;) {
    found = false
    // Nearest first, so a station comes together where most of its
    // platforms are
    const pairs = [...edgesAt.keys()].filter(isStation).map((stop) => ({ stop, linked: link(stop) }))
      .filter((p) => p.linked).sort((a, b) => length(a.linked!.path) - length(b.linked!.path))
    for (const { stop } of pairs) {
      if (!edgesAt.has(stop)) continue
      const linked = link(stop)
      if (!linked) continue
      // Into the stop with the most lines, along the track between
      const [keep, start] = lines(stop) >= lines(linked.to) ? [stop, linked.path] : [linked.to, [...linked.path].reverse()]
      const at = nodes.get(keep).geometry.coordinates
      for (const e of start) {
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

/** The turn restrictions at one end of ways merged into `kept`: each line
 *  can turn from it as it could from any of them. */
function carryTurns(end: string, kept: any, merged: any[]) {
  const node = nodes.get(end)
  if (!node?.properties.excluded_conn) return
  const next = (way: any) => other(way.edges.find((e: any) => e.properties.from === end || e.properties.to === end), end)
  const k = next(kept)
  const has = (way: any, line: string) => way.lines.some((l: any) => l.id === line)
  const excluded = (line: string, a: string, b: string) => node.properties.excluded_conn.some((c: any) => c.line === line
    && ((c.node_from === a && c.node_to === b) || (c.node_from === b && c.node_to === a)))
  const conns: any[] = []
  for (const c of node.properties.excluded_conn) {
    const x = c.node_from === k ? c.node_to : c.node_to === k ? c.node_from : undefined
    // A line kept from turning off `kept` can if it could from a merged way
    if (x !== undefined && merged.some((way) => has(way, c.line) && !excluded(c.line, next(way), x))) continue
    conns.push(c)
  }
  // A line new to `kept` can't turn where it couldn't from its merged ways
  for (const way of merged) {
    const d = next(way)
    for (const c of node.properties.excluded_conn) {
      if (has(kept, c.line) || (c.node_from !== d && c.node_to !== d)) continue
      conns.push({ ...c, node_from: c.node_from === d ? k : c.node_from, node_to: c.node_to === d ? k : c.node_to })
    }
  }
  node.properties.excluded_conn = conns
}

/** Of short ways of about the same length between the same two points,
 *  keeps the shortest, carrying all their lines. */
function mergeParallel() {
  // Where ways start and end: junctions, ends and stations
  const isEnd = (n: string) => edgesAt.get(n)?.length !== 2 || isStation(n)
  const ways = new Map<string, { ends: string[]; lines: any[]; edges: any[]; inner: string[]; length: number }[]>()
  const walked = new Set<any>()
  const loops: any[][] = []
  for (const start of edgesAt.keys()) {
    if (!isEnd(start)) continue
    for (const first of edgesAt.get(start)!) {
      if (walked.has(first)) continue
      const way: any[] = [first], inner: string[] = []
      let at = other(first, start)
      while (!isEnd(at) && at !== start) {
        inner.push(at)
        const next = edgesAt.get(at)!.find((e) => e !== way[way.length - 1])!
        way.push(next)
        at = other(next, at)
      }
      for (const e of way) walked.add(e)
      // A short way back to where it started goes nowhere: a loop
      if (start === at) {
        const length = way.reduce((sum, e) => sum + metres(e.geometry.coordinates), 0)
        if (length <= MAX_LENGTH) { loops.push(way); for (const n of inner) nodes.delete(n) }
        continue
      }
      if (new Set(way.map(linesOf)).size !== 1) continue
      const ends = [start, at].sort().join(' ')
      ;(ways.get(ends) ?? ways.set(ends, []).get(ends)!).push({
        ends: [start, at], lines: way[0].properties.lines, edges: way, inner, length: way.reduce((sum, e) => sum + metres(e.geometry.coordinates), 0),
      })
    }
  }
  const merges = [...ways.values()].filter((group) => group.length > 1
    && Math.max(...group.map((w) => w.length)) <= Math.min(MAX_LENGTH, Math.min(...group.map((w) => w.length)) * LENGTH_RATIO))
  const dropped = new Set<any>()
  for (const group of merges) {
    group.sort((a, b) => a.length - b.length)
    const lines = new Map<string, any>()
    for (const way of group) for (const l of way.lines) lines.set(l.id, l)
    for (const end of group[0].ends) carryTurns(end, group[0], group.slice(1))
    for (const e of group[0].edges) e.properties.lines = [...lines.values()]
    for (const way of group.slice(1)) {
      for (const e of way.edges) dropped.add(e)
      for (const n of way.inner) nodes.delete(n)
    }
  }
  for (const loop of loops) for (const e of loop) dropped.add(e)
  edges = edges.filter((e) => !dropped.has(e))
  index()
  return merges.length + loops.length
}

/** Removes station-free bypasses (see the top of this file), the longest
 *  first, one at a time, so of two that are each other's alternative only
 *  one goes. Logs each one removed. */
function dropBypasses() {
  // Flat metres near a point, for how far apart two routes are
  const flat = ([lon, lat]: [number, number]) => [lon * 111_320 * Math.cos((lat * Math.PI) / 180), lat * 110_540]
  const apart = (p: number[], a: number[], b: number[]) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy
    const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
  }
  const isEnd = (n: string) => edgesAt.get(n)?.length !== 2 || isStation(n)
  /** Ways between ends: junctions, ends of lines and stations. */
  function ways() {
    const found: { ends: [string, string]; edges: any[]; inner: string[]; length: number }[] = []
    const walked = new Set<any>()
    for (const start of edgesAt.keys()) {
      if (!isEnd(start)) continue
      for (const first of edgesAt.get(start)!) {
        if (walked.has(first)) continue
        const way: any[] = [first], inner: string[] = []
        let at = other(first, start)
        while (!isEnd(at) && at !== start) {
          inner.push(at)
          const next = edgesAt.get(at)!.find((e) => e !== way[way.length - 1])!
          way.push(next)
          at = other(next, at)
        }
        for (const e of way) walked.add(e)
        if (at !== start) found.push({ ends: [start, at], edges: way, inner, length: way.reduce((sum, e) => sum + metres(e.geometry.coordinates), 0) })
      }
    }
    return found
  }
  /** The shortest route between a way's ends, not along it, on track that
   *  carries all its lines, if one's about as long and close by. */
  function alternative(way: ReturnType<typeof ways>[number]) {
    const [a, b] = way.ends
    const lines = [...new Set<string>(way.edges.flatMap((e) => e.properties.lines.map((l: any) => l.id)))]
    const carries = (e: any) => !way.edges.includes(e) && lines.every((id) => e.properties.lines.some((l: any) => l.id === id))
    const longest = way.length * BYPASS_RATIO
    const distance = new Map([[a, 0]]), via = new Map<string, any>(), settled = new Set<string>()
    for (;;) {
      let at: string | undefined, best = Infinity
      for (const [n, d] of distance) if (!settled.has(n) && d < best) [at, best] = [n, d]
      if (at === undefined || at === b || best > longest) break
      settled.add(at)
      for (const e of edgesAt.get(at)!) {
        if (!carries(e)) continue
        const next = other(e, at), d = best + metres(e.geometry.coordinates)
        if (d < (distance.get(next) ?? Infinity)) { distance.set(next, d); via.set(next, e) }
      }
    }
    const length = distance.get(b)
    if (length === undefined || length > longest || length * BYPASS_RATIO < way.length) return
    const route: any[] = []
    for (let n = b; n !== a;) { const e = via.get(n); route.push(e); n = other(e, n) }
    const segments = route.flatMap((e) => { const c = e.geometry.coordinates.map(flat); return c.slice(1).map((q: number[], i: number) => [c[i], q]) })
    for (const e of way.edges) {
      for (const point of e.geometry.coordinates) {
        const p = flat(point)
        if (!segments.some(([s, t]: number[][]) => apart(p, s, t) <= BYPASS_APART)) return
      }
    }
    return { length, stations: route.flatMap((e) => [e.properties.from, e.properties.to]).filter(isStation) }
  }

  let dropped = 0
  for (;;) {
    const bypasses = ways()
      .filter((w) => w.ends[0] !== w.ends[1] && w.length >= MIN_BYPASS)
      .sort((x, y) => y.length - x.length)
    let way, alt
    for (const w of bypasses) if ((alt = alternative(w))) { way = w; break }
    if (!way || !alt) break
    const [lon, lat] = way.edges[Math.floor(way.edges.length / 2)].geometry.coordinates[0]
    const names = [...new Set(alt.stations.map((n: string) => nodes.get(n).properties.station_label))]
    console.error(`  bypass at ${lat.toFixed(4)},${lon.toFixed(4)}: ${Math.round(way.length)} m, removed for ${Math.round(alt.length)} m${names.length ? ` via ${names.join(', ')}` : ''} (${[...new Set(way.edges.flatMap((e) => e.properties.lines.map((l: any) => l.id)))].join(', ')})`)
    edges = edges.filter((e) => !way.edges.includes(e))
    for (const n of way.inner) nodes.delete(n)
    index()
    dropped++
  }
  return dropped
}

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
const neighbours = new Map<string, Set<string>>()
const tracks = new Map<string, number>()
for (const e of edges) {
  const { from, to } = e.properties
  ;(neighbours.get(from) ?? neighbours.set(from, new Set()).get(from)!).add(to)
  ;(neighbours.get(to) ?? neighbours.set(to, new Set()).get(to)!).add(from)
  for (const n of [from, to]) tracks.set(n, (tracks.get(n) ?? 0) + 1)
}
let unblocked = 0
const kept = [...nodes.values()].filter((n) => neighbours.has(n.properties.id)).map((n) => {
  const near = neighbours.get(n.properties.id)!
  const through = tracks.get(n.properties.id) === 2
  if (through && n.properties.excluded_conn?.length) unblocked++
  const conns = n.properties.excluded_conn?.filter((c: any) => !through && near.has(c.node_from) && near.has(c.node_to))
  return conns ? { ...n, properties: { ...n.properties, excluded_conn: conns } } : n
})

// Turns services make that topo didn't allow
let lifted = 0
if (process.argv[3] && process.argv[4]) {
  const routes: Route[] = JSON.parse(readFileSync(process.argv[3], 'utf8'))
  const { nodes: byId, runs, way } = services([...kept, ...edges], JSON.parse(readFileSync(process.argv[4], 'utf8')).features)
  for (const run of runs(routes).runs) {
    if (way(run)) continue
    const turns = way(run, true)
    if (!turns) continue
    const line = run.route.line
    for (let i = 1; i < turns.length - 1; i++) {
      const node = byId.get(turns[i])
      const [a, b] = [turns[i - 1], turns[i + 1]]
      const before = node.properties.excluded_conn?.length ?? 0
      node.properties.excluded_conn = node.properties.excluded_conn?.filter((c: any) =>
        !(c.line === line && ((c.node_from === a && c.node_to === b) || (c.node_from === b && c.node_to === a))))
      if ((node.properties.excluded_conn?.length ?? 0) < before) lifted++
    }
  }
}

console.error(`Joined ${stops} pairs of stops and ${joined} of junctions, merged ${merged} sets of parallel ways, removed ${bypasses} bypasses, let lines run on through ${unblocked} nodes of two tracks, lifted ${lifted} turn restrictions services make`)
process.stdout.write(JSON.stringify({ ...graph, features: [...kept, ...edges] }))
