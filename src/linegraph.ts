// Writes a LOOM line graph (GeoJSON) of Britain's train services from an
// OpenStreetMap extract.
//
//   node src/linegraph.ts <extract.osm.pbf> > linegraph.json
//
// Each `route=train` relation is one service (and the Tyne and Wear Metro's
// `route=light_rail` ones). Services are grouped into lines (see lines.ts):
// Intercity services, other National Rail services, and a few with their
// own line. The OSM ways the services run on become edges (just the parts of
// each way the trains use), split at junctions, stops and where the lines
// change, and each edge lists the lines using it. Stops become station
// nodes named after the stop. LOOM's `topo` then merges parallel tracks
// into one edge per corridor.
//
// Needs osmium (`brew install osmium-tool`).

import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lineColour, routeLine } from './lines.ts'

type LatLon = [number, number]

const pbf = process.argv[2]
if (!pbf) {
  console.error('Usage: node src/linegraph.ts <extract.osm.pbf>')
  process.exit(1)
}

function run(cmd: string, cmdArgs: string[]) {
  const result = spawnSync(cmd, cmdArgs, { stdio: ['ignore', 'ignore', 'inherit'] })
  if (result.error) throw new Error(`${cmd} failed: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${cmd} ${cmdArgs[0]} exited with ${result.status}`)
}

/** OPL escapes special characters in tags as %hex%. */
function unescape(value: string): string {
  return value.replace(/%([0-9a-f]+)%/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
}

function parseTags(field: string | undefined): Record<string, string> {
  const tags: Record<string, string> = {}
  if (!field || field.length <= 1) return tags
  for (const pair of field.slice(1).split(',')) {
    const eq = pair.indexOf('=')
    if (eq > 0) tags[unescape(pair.slice(0, eq))] = unescape(pair.slice(eq + 1))
  }
  return tags
}

/** Routes whose train company isn't known, by name, to report. */
const unknown = new Map<string, number>()

/** The line a service draws as (see routeLine in lines.ts). Light rail is
 *  only the Tyne and Wear Metro, not trams. Routes of no known company
 *  (heritage railways, charters, mistagged track) are left out. */
function serviceLine(tags: Record<string, string>): string {
  if (tags.route === 'light_rail' && tags.network !== 'Tyne and Wear Metro') return ''
  const line = routeLine(tags)
  if (!line) {
    const name = tags.brand || tags.operator || tags.network || tags.name || '(unnamed)'
    unknown.set(name, (unknown.get(name) ?? 0) + 1)
  }
  return line ?? ''
}

/** Track trains run on: heritage, tourist and non-rail ways are left out.
 *  Track tagged as under construction is kept, as only ways in routes are
 *  used, and some are left tagged so after work on them (Whitehaven Tunnel). */
function isTrack(tags: Record<string, string>): boolean {
  return (tags.railway === 'rail' || tags.railway === 'light_rail' || tags.railway === 'construction') &&
    tags['railway:preserved'] !== 'yes' && tags.usage !== 'tourism'
}

/** Northern Ireland isn't on National Rail. */
function inNorthernIreland([lat, lon]: LatLon): boolean {
  return lon < -5.45 && lat > 54.0 && lat < 55.4
}

// MARK: Read services

const work = mkdtempSync(join(tmpdir(), 'linegraph-'))
const routes = join(work, 'routes.osm.pbf')
run('osmium', ['tags-filter', pbf, 'r/route=train,light_rail', '-o', routes, '--overwrite'])

const coords = new Map<number, LatLon>()
const names = new Map<number, string>()
const wayNodes = new Map<number, number[]>()
const stopNodes = new Set<number>()
/** The lines on each stretch of track between neighbouring nodes. */
const segmentLines = new Map<string, Set<string>>()
const segment = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`)

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

// OPL lists nodes, then ways, then relations
const opl = spawn('osmium', ['cat', routes, '-f', 'opl,add_metadata=false'])
for await (const line of createInterface({ input: opl.stdout })) {
  const fields = line.split(' ')
  const type = fields[0][0]
  const id = Number(fields[0].slice(1))
  const tags = parseTags(fields.find((f) => f[0] === 'T'))
  if (type === 'n') {
    const x = fields.find((f) => f[0] === 'x')
    const y = fields.find((f) => f[0] === 'y')
    if (x && y && x.length > 1) coords.set(id, [Number(y.slice(1)), Number(x.slice(1))])
    if (tags.name) names.set(id, tags.name)
  } else if (type === 'w') {
    if (!isTrack(tags)) continue
    const refs = fields.find((f) => f[0] === 'N')
    if (refs && refs.length > 1) wayNodes.set(id, refs.slice(1).split(',').map((r) => Number(r.slice(1))).filter((n) => coords.has(n)))
  } else if (type === 'r') {
    const service = serviceLine(tags)
    if (!service) continue
    // Members, in route order: w123@role,n456@role,…
    const ways: number[][] = []
    const stops = new Set<number>()
    for (const member of (fields.find((f) => f[0] === 'M') ?? 'M').slice(1).split(',')) {
      const at = member.indexOf('@')
      const memberId = Number(member.slice(1, at))
      const role = member.slice(at + 1)
      if (member[0] === 'w' && wayNodes.get(memberId)?.length! > 1) ways.push(wayNodes.get(memberId)!)
      if (member[0] === 'n' && role.startsWith('stop')) { stopNodes.add(memberId); stops.add(memberId) }
    }
    ways.forEach((nodes, i) => {
      const used = usedPart(nodes, ways[i - 1], ways[i + 1], stops)
      for (let j = 1; j < used.length; j++) {
        const key = segment(used[j - 1], used[j])
        segmentLines.get(key)?.add(service) ?? segmentLines.set(key, new Set([service]))
      }
    })
  }
}
rmSync(work, { recursive: true, force: true })

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

function addEdge(piece: number[]) {
  const lines = linesOf(piece[0], piece[1]).split('|')
  if (inNorthernIreland(coords.get(piece[0])!)) return
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
for (const nodes of wayNodes.values()) {
  let piece: number[] = []
  for (let i = 1; i < nodes.length; i++) {
    const [a, b] = [nodes[i - 1], nodes[i]]
    const key = segment(a, b)
    if (!segmentLines.has(key) || drawn.has(key)) {
      if (piece.length > 1) addEdge(piece)
      piece = []
      continue
    }
    drawn.add(key)
    if (piece.length > 1 && (splitsAt(a) || linesOf(piece[piece.length - 2], a) !== linesOf(a, b))) {
      addEdge(piece)
      piece = []
    }
    if (!piece.length) piece.push(a)
    piece.push(b)
  }
  if (piece.length > 1) addEdge(piece)
}
// Each stop is its own station to topo: it merges stations with the same id,
// and runs every line calling there through one point, which pulls lines off
// their track where a station's platforms are apart (the Elizabeth line
// under Whitechapel). Stops are grouped into stations for drawing instead
// (stationDots in render.ts)
for (const n of usedNodes) {
  const station = stopNodes.has(n) ? names.get(n) : undefined
  const id = station && `n${n}`
  features.push({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: lonLat(n) },
    properties: { id: `n${n}`, ...(station ? { station_id: id, station_label: station } : {}) },
  })
}

if (unknown.size) console.error(`Left out routes of unknown companies: ${[...unknown].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} (${c})`).join(', ')}`)
const lineCount = new Set([...segmentLines.values()].flatMap((l) => [...l])).size
console.error(`${edgeId} edges, ${usedNodes.size} nodes, ${lineCount} lines, ${[...usedNodes].filter((n) => stopNodes.has(n)).length} stops`)
process.stdout.write(JSON.stringify({ type: 'FeatureCollection', features }))
