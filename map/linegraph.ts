// Writes a LOOM line graph (GeoJSON) of Britain's train services from an
// OpenStreetMap extract.
//
//   node map/linegraph.ts <extract.osm.pbf> [routes.json [names.json [stations.json]]] > linegraph.json
//
// With routes.json, also writes each service's stops in order, for check.ts
// to see that the finished map still runs each service from stop to stop:
// [{ name, line, stops: [node ids] }]. With names.json, also writes what
// each line is called along each stretch of its track, for render.ts to
// label it: [[line, name, [[lon, lat], …]]]. National Rail is called by its
// track's name (West Coast Main Line), the Overground by each of its lines'
// (Windrush line), and other lines by their own. With stations.json, also
// writes which station each stop is, { station_id: key }, its CRS code (see
// stationGroups.ts), for later steps to join and match a station's stops.
//
// Each `route=train` relation is one service (and the Tyne and Wear Metro's
// `route=light_rail` ones). Services are grouped into lines (see lines.ts):
// National Rail services, and a few with their
// own line. The OSM ways the services run on become edges (just the parts of
// each way the trains use), split at junctions, stops and where the lines
// change, and each edge lists the lines using it. Stops become station
// nodes named after their station (stationGroups.ts). LOOM's `topo` then merges parallel tracks
// into one edge per corridor.
//
// Needs osmium (`brew install osmium-tool`).

import { writeFileSync } from 'node:fs'
import { simplifyLatLon } from './lib/geo.ts'
import { lineColour, serviceLine } from './lines.ts'
import { filtered, inNorthernIreland, type LatLon } from './lib/osm.ts'
import { type CodedStation, type StopArea, stationGroups } from './lib/stationGroups.ts'

const pbf = process.argv[2]

if (!pbf) {
  console.error('Usage: node map/linegraph.ts <extract.osm.pbf> [routes.json]')
  process.exit(1)
}

/** Train routes left out as of no known company, by name, to report. */
const unknown = new Map<string, number>()

/** Track trains run on: heritage, tourist and non-rail ways are left out.
 *  Track tagged as under construction is kept, as only ways in routes are
 *  used, and some are left tagged so after work on them (Whitehaven Tunnel). */
function isTrack(tags: Record<string, string>): boolean {
  return (tags.railway === 'rail' || tags.railway === 'light_rail' || tags.railway === 'construction') &&
    tags['railway:preserved'] !== 'yes' && tags.usage !== 'tourism'
}

// MARK: Read services

const coords = new Map<number, LatLon>()
const names = new Map<number, string>()
const wayNodes = new Map<number, number[]>()
const stopNodes = new Set<number>()

/** Stations and stop positions on the track, the stops of routes listing
 *  none of their own (some tagged only as Network Rail's): topo trims a
 *  line back to its last station. */
const trackStops = new Set<number>()

/** The lines on each stretch of track between neighbouring nodes. */
const segmentLines = new Map<string, Set<string>>()

/** Track ways' names, and the Overground lines (their routes' `ref`, such as
 *  Windrush) on each stretch, for names.json. */
const wayNames = new Map<number, string>()
const segmentRefs = new Map<string, Map<string, number>>()
const segment = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`)

/** Stations with a CRS code, and stop areas, to group stops into stations. */
const coded = new Map<number, CodedStation>()
const stopAreas: StopArea[] = []

/** Each service, its line and stops in order, for check.ts. */
const routes: { name: string; line: string; stops: number[] }[] = []

/** The part of a way a train uses. Routes list whole OSM ways, but a way
 *  often runs on past the junction where the train joins or leaves it, so
 *  this keeps only the nodes between where it joins (from the way before)
 *  and leaves (onto the way after). At the ends of a route, or a gap in it,
 *  it starts or ends at the route's stop on the way, if any. */
function usedPart(nodes: number[], before: number[] | undefined, after: number[] | undefined, stops: Set<number>): number[] {
  const join = (other: number[] | undefined) => (other ? nodes.findIndex((n) => other.includes(n)) : -1)
  const stop = nodes.findIndex((n) => stops.has(n))
  let from = join(before), to = join(after)
  if (from < 0 && to < 0) return nodes

  if (from < 0) from = stop >= 0 && stop !== to ? stop : to > 0 ? 0 : nodes.length - 1
  if (to < 0) to = stop >= 0 && stop !== from ? stop : from > 0 ? 0 : nodes.length - 1

  return nodes.slice(Math.min(from, to), Math.max(from, to) + 1)
}

for await (const { type, id, tags, at, nodes, members } of filtered(pbf, ['r/route=train,light_rail', 'r/public_transport=stop_area', 'n/ref:crs'])) {
  if (type === 'n') {
    if (at) coords.set(id, at)
    if (tags.name) names.set(id, tags.name)
    if (tags['ref:crs'] && at) coded.set(id, { crs: tags['ref:crs'], name: tags.name, at })
    if (tags.name && (['stop', 'station', 'halt'].includes(tags.railway) || tags.public_transport === 'stop_position') && tags.train !== 'no' && tags.usage !== 'tourism') trackStops.add(id)
  } else if (type === 'w') {
    if (isTrack(tags) && nodes!.length) {
      wayNodes.set(id, nodes!.filter((n) => coords.has(n)))

      if (tags.name) wayNames.set(id, tags.name)
    }
  } else if (tags.public_transport === 'stop_area') {
    stopAreas.push({ crs: tags['ref:crs'], members: members!.filter((m) => m.type === 'n').map((m) => m.id) })
  } else if (tags.route === 'train' || tags.route === 'light_rail') {
    // Only train routes: stop areas can bring in others (bus, ferry) they list
    const ways: number[][] = []
    const stops = new Set<number>()

    for (const member of members!) {
      if (member.type === 'w' && wayNodes.get(member.id)?.length! > 1) ways.push(wayNodes.get(member.id)!)
      if (member.type === 'n' && member.role.startsWith('stop')) stops.add(member.id)
    }

    if (!stops.size) for (const n of ways.flat()) if (trackStops.has(n)) stops.add(n)

    const service = serviceLine(tags, [...stops].map((n) => names.get(n) ?? ''))

    if (!service) {
      const name = tags.brand || tags.operator || tags.network || tags.name || '(unnamed)'

      if (tags.route === 'train') unknown.set(name, (unknown.get(name) ?? 0) + 1)

      continue
    }

    for (const n of stops) stopNodes.add(n)

    routes.push({ name: tags.name || `r${id}`, line: service, stops: [...stops] })

    ways.forEach((nodes, i) => {
      const used = usedPart(nodes, ways[i - 1], ways[i + 1], stops)

      for (let j = 1; j < used.length; j++) {
        const key = segment(used[j - 1], used[j])

        segmentLines.get(key)?.add(service) ?? segmentLines.set(key, new Set([service]))

        if (service === 'London Overground' && tags.ref) {
          const refs = segmentRefs.get(key) ?? segmentRefs.set(key, new Map()).get(key)!

          refs.set(tags.ref, (refs.get(tags.ref) ?? 0) + 1)
        }
      }
    })
  }
}

// MARK: Build the graph

// Track nodes joining other than two used stretches are junctions or ends
const degree = new Map<number, number>()

for (const key of segmentLines.keys()) for (const n of key.split('-').map(Number)) degree.set(n, (degree.get(n) ?? 0) + 1)

const splitsAt = (n: number) => degree.get(n) !== 2 || stopNodes.has(n)

type Feature = { type: 'Feature'; geometry: unknown; properties: Record<string, unknown> }

const features: Feature[] = []
const usedNodes = new Set<number>()
const lonLat = (n: number) => [coords.get(n)![1], coords.get(n)![0]]
const linesOf = (a: number, b: number) => [...(segmentLines.get(segment(a, b)) ?? [])].sort().join('|')
const drawn = new Set<string>()
let edgeId = 0

/** What each line is called along stretches of track, for names.json. */
const lineNames: [string, string, LatLon[]][] = []

/** What a line is called along a piece of track on a way. */
function lineName(line: string, way: number, piece: number[]): string | undefined {
  if (line === 'National Rail') return wayNames.get(way)

  if (line === 'London Overground') {
    // Whichever of its lines most services here are
    const counts = new Map<string, number>()

    for (let i = 1; i < piece.length; i++) for (const [ref, n] of segmentRefs.get(segment(piece[i - 1], piece[i])) ?? []) counts.set(ref, (counts.get(ref) ?? 0) + n)

    const ref = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]

    return ref ? `${ref} line` : 'London Overground'
  }

  return line
}

function addEdge(piece: number[], way: number) {
  const lines = linesOf(piece[0], piece[1]).split('|')
  if (inNorthernIreland(coords.get(piece[0])!)) return

  for (const line of lines) {
    const name = lineName(line, way, piece)

    if (name) lineNames.push([line, name, simplifyLatLon(piece.map((n) => coords.get(n)!), 20)])
  }

  usedNodes.add(piece[0]).add(piece[piece.length - 1])

  features.push({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: piece.map(lonLat) },
    properties: {
      id: `e${edgeId++}`,
      from: `n${piece[0]}`,
      to: `n${piece[piece.length - 1]}`,
      lines: lines.map((l) => ({ id: l, label: l, color: lineColour(l) })),
    },
  })
}

// Edges follow the ways, split at junctions, stops and where lines change
for (const [way, nodes] of wayNodes) {
  let piece: number[] = []

  for (let i = 1; i < nodes.length; i++) {
    const [a, b] = [nodes[i - 1], nodes[i]]
    const key = segment(a, b)

    if (!segmentLines.has(key) || drawn.has(key)) {
      if (piece.length > 1) addEdge(piece, way)

      piece = []
      continue
    }

    drawn.add(key)

    const before = piece[piece.length - 2]

    if (piece.length > 1 && (splitsAt(a) || linesOf(before, a) !== linesOf(a, b))) {
      addEdge(piece, way)
      piece = []
    }

    if (!piece.length) piece.push(a)

    piece.push(b)
  }

  if (piece.length > 1) addEdge(piece, way)
}

const stations = stationGroups([...stopNodes].filter((n) => coords.has(n)).map((n) => ({ id: n, name: names.get(n), at: coords.get(n)! })), coded, stopAreas)

// Each stop is its own station to topo: it merges stations with the same id,
// and runs every line calling there through one point, which pulls lines off
// their track where a station's platforms are apart (the Elizabeth line
// under Whitechapel). Stops are grouped into stations for drawing instead
// (stationDots in render.ts)
for (const n of usedNodes) {
  const station = stopNodes.has(n) ? stations.get(n) : undefined

  features.push({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: lonLat(n) },
    properties: { id: `n${n}`, ...(station ? { station_id: `n${n}`, station_label: station.name } : {}) },
  })
}

if (unknown.size) console.error(`Left out routes of unknown companies: ${[...unknown].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} (${c})`).join(', ')}`)

const lineCount = new Set([...segmentLines.values()].flatMap((l) => [...l])).size

console.error(`${edgeId} edges, ${usedNodes.size} nodes, ${lineCount} lines, ${[...usedNodes].filter((n) => stopNodes.has(n)).length} stops`)
process.stdout.write(JSON.stringify({ type: 'FeatureCollection', features }))

// Only stops on the graph: a route's stops on track that isn't (Northern
// Ireland, ways left out) can't be checked
if (process.argv[3]) {
  writeFileSync(process.argv[3], JSON.stringify(routes.map((r) => ({ ...r, stops: r.stops.filter((n) => usedNodes.has(n)).map((n) => `n${n}`) }))))
}

if (process.argv[5]) {
  const keys = [...usedNodes].filter((n) => stopNodes.has(n) && stations.has(n)).map((n) => [`n${n}`, stations.get(n)!.key])

  writeFileSync(process.argv[5], JSON.stringify(Object.fromEntries(keys)))

  const named = new Set(keys.map(([, key]) => key))

  console.error(`${keys.length} stops at ${named.size} stations, ${[...named].filter((k) => k.startsWith('name:')).length} of them with no CRS code`)
}

if (process.argv[4]) {
  const round = (v: number) => Math.round(v * 1e5) / 1e5

  writeFileSync(process.argv[4], JSON.stringify(lineNames.map(([line, name, path]) => [line, name, path.map(([lat, lon]) => [round(lon), round(lat)])])))
}
