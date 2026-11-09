// Checks the finished line graph still runs each service from stop to stop,
// like a real line: that from each of its stops, its line's track leads on to
// the next without breaks, turning only where loom lets it (each node's
// excluded_conn), and never reversing. Lists the breaks, by line, for
// fixing upstream (topo, tidy); the build carries on regardless.
//
//   node src/check.ts routes.json linegraph.json map.json
//
// routes.json and linegraph.json are from linegraph.ts; map.json is loom's
// output (gb.map.json). Stops are matched as routes.ts does; a stop that
// matches none is skipped, joining the stops either side.

import { readFileSync } from 'node:fs'
import { services, type Route } from './routes.ts'

const [routesFile, linegraphFile, mapFile] = process.argv.slice(2)
if (!routesFile || !linegraphFile || !mapFile) {
  console.error('Usage: node src/check.ts <routes.json> <linegraph.json> <map.json>')
  process.exit(1)
}
const routes: Route[] = JSON.parse(readFileSync(routesFile, 'utf8'))
const { nodes, runs, way } = services(
  JSON.parse(readFileSync(mapFile, 'utf8')).features,
  JSON.parse(readFileSync(linegraphFile, 'utf8')).features,
)

const label = (node: string) => nodes.get(node)?.properties.station_label ?? node
/** Breaks, each once however many services have it: by line, then the two
 *  stops either side (in either order), with the services. */
const breaks = new Map<string, { line: string; from: string; to: string; services: string[] }>()
const found = runs(routes)
for (const run of found.runs) {
  if (way(run)) continue
  const [from, to] = [run.from[0], run.to[0]]
  const key = [run.route.line, ...[from, to].sort()].join('|')
  const seen = breaks.get(key) ?? breaks.set(key, { line: run.route.line, from: label(from), to: label(to), services: [] }).get(key)!
  seen.services.push(run.route.name)
}

const byLine = [...breaks.values()].sort((a, b) => a.line.localeCompare(b.line) || a.from.localeCompare(b.from))
console.error(`Checked ${found.runs.length} stop-to-stop runs of ${routes.length} services (${found.skipped} stops no longer in the graph, skipped): ${breaks.size} breaks`)
for (const b of byLine) {
  const more = b.services.length > 1 ? ` and ${b.services.length - 1} more` : ''
  console.error(`  ${b.line}: ${b.from} → ${b.to} (${b.services[0]}${more})`)
}
