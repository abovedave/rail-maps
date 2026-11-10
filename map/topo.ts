// Merges parallel track into corridors with LOOM's `topo`: first each line's
// track on its own, then all the lines together, only where they're close
// enough to share track.
//
//   node map/topo.ts linegraph.json > topo.json
//
// In one pass, topo merges any lines closer than its distance, even on
// different tracks: the Elizabeth line under Whitechapel was pulled onto the
// Overground above it, and Thameslink under St Pancras onto the King's Cross
// lines. Merged on its own, each line runs down the middle of its own
// tracks, so the second pass only needs to merge lines sharing track, a few
// metres apart.

import { spawnSync } from 'node:child_process'
import { type EdgeFeature, type Feature, type Graph, type NodeFeature, isEdge, isNode, lineIds, readGraph } from './lib/graph.ts'

/** How far apart tracks are merged, in topo's units (Web Mercator metres:
 *  about 0.6 m on the ground in Britain): a line's own, then lines'. */
const LINE_MERGE = 150
const SHARED_MERGE = 80
const SMOOTH = 50
const RESTRICTIONS = ['--turn-restr-full-turn-angle', '60', '--turn-restr-full-turn-pen', '10000']

function topo(features: Feature[], distance: number): Graph {
  const args = ['-d', String(distance), '--smooth', String(SMOOTH), ...RESTRICTIONS]
  const result = spawnSync('vendor/loom/build/topo', args, { input: JSON.stringify({ type: 'FeatureCollection', features }), maxBuffer: 2 ** 31 })

  if (result.status !== 0) throw new Error(`topo failed: ${result.stderr}`)

  return JSON.parse(result.stdout.toString())
}

const edgeCount = (g: Graph) => g.features.filter(isEdge).length
const seconds = (since: number) => Math.round((Date.now() - since) / 1000)

const graph = readGraph(process.argv[2])
const edges = graph.features.filter(isEdge)

// topo treats stations with the same name as one, and drops track between
// them where they're apart: the Abbey Line's stop at Watford Junction, 120 m
// from the main line's, lost its track to Watford North. So each stop's name
// is made its own while topo runs (`name|id`), and put back after
const SEPARATOR = '|'

const withUniqueName = (f: NodeFeature): NodeFeature => f.properties.station_label
  ? { ...f, properties: { ...f.properties, station_label: f.properties.station_label + SEPARATOR + f.properties.id } }
  : f

const withName = (f: Feature): Feature => isNode(f) && f.properties.station_label?.includes(SEPARATOR)
  ? { ...f, properties: { ...f.properties, station_label: f.properties.station_label.slice(0, f.properties.station_label.lastIndexOf(SEPARATOR)) } }
  : f

const nodes = new Map(graph.features.filter(isNode).map((f) => [f.properties.id, withUniqueName(f)]))
const lines = [...new Set(edges.flatMap(lineIds))]

/** A line's own track, merged on its own, its node ids made its own
 *  (`2:n123`) so lines' nodes stay apart until they're merged together. */
function ownTrack(line: string, i: number): Feature[] {
  const own: EdgeFeature[] = edges
    .filter((e) => lineIds(e).includes(line))
    .map((e) => ({ ...e, properties: { ...e.properties, lines: e.properties.lines.filter((l) => l.id === line) } }))

  const ends = new Set(own.flatMap((e) => [e.properties.from, e.properties.to]))
  const started = Date.now()
  const result = topo([...[...ends].map((id) => nodes.get(id)).filter((n) => n !== undefined), ...own], LINE_MERGE)

  console.error(`  ${line}: ${own.length} → ${edgeCount(result)} edges, ${seconds(started)}s`)

  const id = (n: string) => `${i}:${n}`

  return result.features.map((f): Feature => isNode(f)
    ? {
        ...f,
        properties: {
          ...f.properties,
          id: id(f.properties.id),
          excluded_conn: f.properties.excluded_conn?.map((c) => ({ ...c, node_from: id(c.node_from), node_to: id(c.node_to) })),
        },
      }
    : { ...f, properties: { ...f.properties, from: id(f.properties.from), to: id(f.properties.to) } })
}

const merged = lines.flatMap(ownTrack)

// Then the lines together, where they share track
const started = Date.now()
const result = topo(merged, SHARED_MERGE)

console.error(`  together: ${edgeCount(result)} edges, ${seconds(started)}s`)
process.stdout.write(JSON.stringify({ ...result, features: result.features.map(withName) }))
