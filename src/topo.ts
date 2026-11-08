// Merges parallel track into corridors with LOOM's `topo`, in layers: first
// each layer's track on its own (each line: the edges' `layers`, from
// linegraph.ts), then all of them
// together, only where they're close enough to share track.
//
//   node src/topo.ts linegraph.json > topo.json
//
// In one pass, topo merges any lines closer than its distance, even on
// different tracks: the Elizabeth line under Whitechapel was pulled onto the
// Overground above it, and Thameslink under St Pancras onto the King's Cross
// lines. Merged by layer, each layer's lines run down the middle of their
// own tracks, so the second pass only needs to merge layers sharing track, a
// few metres apart.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** A layer's line: National Rail for a company's layer, or the named line. */
const lineOf = (layer: string) => (layer.startsWith('National Rail/') ? 'National Rail' : layer)

/** How far apart tracks are merged, in topo's units (Web Mercator metres:
 *  about 0.6 m on the ground in Britain): a layer's own, then layers'. */
const LAYER_MERGE = 150
const SHARED_MERGE = 100
const SMOOTH = 50
const RESTRICTIONS = ['--turn-restr-full-turn-angle', '60', '--turn-restr-full-turn-pen', '10000']

const topo = (graph: object, args: string[]) => {
  const result = spawnSync('vendor/loom/build/topo', [...args, ...RESTRICTIONS], { input: JSON.stringify(graph), maxBuffer: 2 ** 31 })
  if (result.status !== 0) throw new Error(`topo failed: ${result.stderr}`)
  return JSON.parse(result.stdout.toString())
}

const graph = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const edges = graph.features.filter((f: any) => f.geometry.type === 'LineString')
const nodes = new Map<string, any>(graph.features.filter((f: any) => f.geometry.type === 'Point').map((f: any) => [f.properties.id, f]))
const layers = [...new Set<string>(edges.flatMap((e: any) => e.properties.layers))]

// Each layer merged on its own, with node ids kept apart between layers
const merged = layers.flatMap((layer) => {
  const own = edges
    .filter((e: any) => e.properties.layers.includes(layer))
    .map((e: any) => ({ ...e, properties: { ...e.properties, lines: e.properties.lines.filter((l: any) => l.id === lineOf(layer)) } }))
  const ends = new Set(own.flatMap((e: any) => [e.properties.from, e.properties.to]))
  const started = Date.now()
  const result = topo({ type: 'FeatureCollection', features: [...[...ends].map((id) => nodes.get(id)).filter(Boolean), ...own] },
    ['-d', String(LAYER_MERGE), '--smooth', String(SMOOTH)])
  console.error(`  ${layer}: ${own.length} → ${result.features.filter((f: any) => f.geometry.type === 'LineString').length} edges, ${Math.round((Date.now() - started) / 1000)}s`)
  const id = (n: string) => `${layers.indexOf(layer)}:${n}`
  return result.features.map((f: any) => f.geometry.type === 'Point'
    ? { ...f, properties: { ...f.properties, id: id(f.properties.id), excluded_conn: f.properties.excluded_conn?.map((c: any) => ({ ...c, node_from: id(c.node_from), node_to: id(c.node_to) })) } }
    : { ...f, properties: { ...f.properties, from: id(f.properties.from), to: id(f.properties.to) } })
})

// Then the layers together, where they share track
const started = Date.now()
const result = topo({ type: 'FeatureCollection', features: merged }, ['-d', String(SHARED_MERGE), '--smooth', String(SMOOTH)])
console.error(`  together: ${result.features.filter((f: any) => f.geometry.type === 'LineString').length} edges, ${Math.round((Date.now() - started) / 1000)}s`)
process.stdout.write(JSON.stringify(result))
