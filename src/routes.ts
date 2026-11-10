// Services on the line graph, from stop to stop: shared by tidy.ts (which
// lifts turn restrictions services show are wrong) and check.ts (which checks
// the finished map still runs each service unbroken).
//
// A service is from linegraph.ts's routes.json: its line, and its stops by
// station_id. Topo and tidy keep each station's station_id, but join a
// station's stops into one (keeping one's id), so a stop is also matched to
// the nodes of its station (stationGroups.ts) nearby.

import { type Feature, type NodeFeature, type StationKeys, isEdge, isNode, lineIds, pushTo, stationKey } from './graph.ts'

/** A service: its name, line and stops (station_ids), from linegraph.ts. */
export type Route = { name: string; line: string; stops: string[] }

/** How far a stop can be from the node of its station it was joined into,
 *  in metres (tidy joins a terminus's stops up to 1.5 km apart). */
const MATCH = 2000

/** Metres between two [lon, lat] points, near enough nearby. */
const metres = ([a, b]: number[], [c, d]: number[]) => Math.hypot((a - c) * 111_320 * Math.cos((b * Math.PI) / 180), (b - d) * 110_540)

/** A line graph's services, stop to stop. `features` is the graph (nodes
 *  and edges, as topo, tidy and loom write it), and `stopFeatures` the
 *  line graph's stops, for where each was. */
export function services(features: Feature[], stopFeatures: Feature[], keys: StationKeys) {
  const nodes = new Map<string, NodeFeature>()
  const stationNode = new Map<string, string>()
  const nodesOfStation = new Map<string, NodeFeature[]>()
  for (const f of features) {
    if (!isNode(f)) continue
    nodes.set(f.properties.id, f)
    if (f.properties.station_id) stationNode.set(f.properties.station_id, f.properties.id)
    if (f.properties.station_label) pushTo(nodesOfStation, stationKey(keys, f), f)
  }
  const stopsFound = new Map<string, NodeFeature>()
  for (const f of stopFeatures) if (isNode(f) && f.properties.station_id) stopsFound.set(f.properties.station_id, f)

  /** Each node's edges: the node at the other end, and the lines on it. */
  const next = new Map<string, { to: string; lines: Set<string> }[]>()
  for (const f of features) {
    if (!isEdge(f)) continue
    const { from, to } = f.properties
    const lines = new Set(lineIds(f))
    pushTo(next, from, { to, lines })
    pushTo(next, to, { to: from, lines })
  }
  const carries = (node: string, line: string) => (next.get(node) ?? []).some((e) => e.lines.has(line))
  /** Whether a line may go from one neighbour of a node to another. */
  const allowed = (node: string, line: string, from: string, to: string) =>
    !(nodes.get(node)!.properties.excluded_conn ?? []).some((c) => c.line === line && c.node_from === from && c.node_to === to)

  /** The graph nodes a stop of a line may now be, likeliest first: itself,
   *  then its station's other nodes within MATCH, nearest first, those with the
   *  line's track before those without. A station can have stops apart on
   *  different track (Watford Junction's Abbey Line platform). */
  function nodesFor(stop: string, line: string): string[] {
    const own = stationNode.get(stop)
    const found = stopsFound.get(stop)
    const near = found
      ? (nodesOfStation.get(stationKey(keys, found)) ?? [])
        .map((f) => ({ id: f.properties.id as string, d: metres(f.geometry.coordinates, found.geometry.coordinates) }))
        .filter(({ d }) => d <= MATCH)
        .sort((x, y) => (carries(x.id, line) ? 0 : MATCH) + x.d - ((carries(y.id, line) ? 0 : MATCH) + y.d))
        .map(({ id }) => id)
      : []
    return [...new Set([...(own ? [own] : []), ...near])]
  }

  /** The fewest-edge way along a line's track from one node to another,
   *  never reversing, and turning only where it may (unless `anyTurn`), as
   *  its nodes; or undefined. */
  function path(start: string, end: string, line: string, anyTurn = false): string[] | undefined {
    // States are a node and where the train came from
    const back = new Map<string, string | null>([[`${start}|`, null]])
    const queue: [string, string | null][] = [[start, null]]
    for (let i = 0; i < queue.length; i++) {
      const [at, came] = queue[i]
      if (at === end) {
        const nodesOnWay: string[] = []
        for (let key: string | null = `${at}|${came ?? ''}`; key; key = back.get(key)!) nodesOnWay.unshift(key.split('|')[0])
        return nodesOnWay
      }
      for (const { to, lines } of next.get(at) ?? []) {
        if (!lines.has(line) || to === came || (!anyTurn && came && !allowed(at, line, came, to))) continue
        const state = `${to}|${at}`
        if (back.has(state)) continue
        back.set(state, `${at}|${came ?? ''}`)
        queue.push([to, at])
      }
    }
  }

  /** Each run of a service between consecutive stops, as the nodes each
   *  stop may be, and how many stops matched no node. */
  function runs(routes: Route[]) {
    const found: { route: Route; from: string[]; to: string[] }[] = []
    let skipped = 0
    for (const route of routes) {
      const stops: string[][] = []
      for (const stop of route.stops) {
        const candidates = nodesFor(stop, route.line)
        if (!candidates.length) { skipped++; continue }
        const last = stops[stops.length - 1]
        if (!last || last[0] !== candidates[0]) stops.push(candidates)
      }
      for (let i = 1; i < stops.length; i++) found.push({ route, from: stops[i - 1], to: stops[i] })
    }
    return { runs: found, skipped }
  }

  /** The way a run goes: any of its first stop's nodes to any of its
   *  second's, as `path` finds it. */
  function way(run: { route: Route; from: string[]; to: string[] }, anyTurn = false): string[] | undefined {
    for (const a of run.from) for (const b of run.to) {
      if (a === b) return [a]
      const found = path(a, b, run.route.line, anyTurn)
      if (found) return found
    }
  }

  return { nodes, runs, way }
}
