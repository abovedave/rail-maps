// Simplifies knots topo leaves in the line graph, where tracks split apart
// for a short way further than topo merges (twin tunnels at a junction, fast
// and slow lines in separate tunnels, flyovers), so they'd be drawn as loops,
// lines running apart and back together, or tangles of junctions:
//
// - junctions joined by a short track become one junction
// - of short ways of about the same length between the same two points, the
//   shortest is kept, carrying all their lines
// - short ways back to where they started are removed
//
// repeated until neither changes anything.
//
//   node src/tidy.ts topo.json [scale] > tidy.json
//
// `scale` multiplies the distances below, for maps drawn further out.

import { readFileSync } from 'node:fs'

const scale = Number(process.argv[3] ?? 1)
/** Junctions joined by a track shorter than this, in metres, become one. */
const MIN_TRACK = 200 * scale
/** How far along a track, in metres, a junction's move eases out, so lines
 *  bend smoothly into where it's moved to. */
const EASE = 300 * scale
/** Ways between the same points are merged if they're all shorter than
 *  this, in metres, and none is more than LENGTH_RATIO times another. */
const MAX_LENGTH = 2000 * scale
const LENGTH_RATIO = 1.5

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
  const link = new Set(e.properties.lines.map((l: any) => l.id))
  const tracks = [a, b].flatMap((at) => edgesAt.get(at)!.filter((x) => x !== e)
    .map((x) => ({ at, to: other(x, at), lines: new Set<string>(x.properties.lines.map((l: any) => l.id)) })))
    .filter((t) => t.to !== a && t.to !== b)
  const conns: any[] = []
  for (const [i, p] of tracks.entries()) {
    for (const q of tracks.slice(i + 1)) {
      if (p.to === q.to) continue
      for (const line of p.lines) {
        if (!q.lines.has(line)) continue
        const ok = p.at === q.at
          ? allowed(p.at, line, p.to, q.to)
          : link.has(line) && allowed(p.at, line, p.to, q.at) && allowed(q.at, line, p.at, q.to)
        if (!ok) conns.push({ line, node_from: p.to, node_to: q.to }, { line, node_from: q.to, node_to: p.to })
      }
    }
  }
  return conns
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
    const conns = joinedRestrictions(e, a, b)
    // b becomes a, half way between them
    const [ax, ay] = nodes.get(a).geometry.coordinates, [bx, by] = nodes.get(b).geometry.coordinates
    const middle = [(ax + bx) / 2, (ay + by) / 2]
    nodes.get(a).geometry.coordinates = middle
    edges = edges.filter((x) => x !== e)
    for (const x of edges) {
      for (const end of ['from', 'to'] as const) {
        if (x.properties[end] === b) x.properties[end] = a
        if (x.properties[end] === a) {
          const c = x.geometry.coordinates
          x.geometry.coordinates = end === 'from' ? moveStart(c, middle) : moveStart([...c].reverse(), middle).reverse()
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
    joined++
  }
  return joined
}

/** Of short ways of about the same length between the same two points,
 *  keeps the shortest, carrying all their lines. */
function mergeParallel() {
  // Where ways start and end: junctions, ends and stations
  const isEnd = (n: string) => edgesAt.get(n)?.length !== 2 || isStation(n)
  const ways = new Map<string, { lines: any[]; edges: any[]; inner: string[]; length: number }[]>()
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
        lines: way[0].properties.lines, edges: way, inner, length: way.reduce((sum, e) => sum + metres(e.geometry.coordinates), 0),
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

index()
let joined = 0, merged = 0
for (let round = 0; round < 10; round++) {
  const j = joinJunctions(), m = mergeParallel()
  joined += j
  merged += m
  if (!j && !m) break
}

// Turn restrictions only between nodes still next to each other
const neighbours = new Map<string, Set<string>>()
for (const e of edges) {
  const { from, to } = e.properties
  ;(neighbours.get(from) ?? neighbours.set(from, new Set()).get(from)!).add(to)
  ;(neighbours.get(to) ?? neighbours.set(to, new Set()).get(to)!).add(from)
}
const kept = [...nodes.values()].filter((n) => neighbours.has(n.properties.id)).map((n) => {
  const near = neighbours.get(n.properties.id)!
  const conns = n.properties.excluded_conn?.filter((c: any) => near.has(c.node_from) && near.has(c.node_to))
  return conns ? { ...n, properties: { ...n.properties, excluded_conn: conns } } : n
})

console.error(`Joined ${joined} pairs of junctions, merged ${merged} sets of parallel ways`)
process.stdout.write(JSON.stringify({ ...graph, features: [...kept, ...edges] }))
