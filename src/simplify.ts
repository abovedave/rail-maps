// Builds each zoom band's line graph (see bands.ts): the first by tidying
// topo's output, the rest by merging the one before further with topo and
// tidying again, then ordering each one's lines with loom.
//
//   node src/simplify.ts    reads out/gb.topo.json, writes out/gb.map.<zoom>.json

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { BANDS, MERCATOR_METRES, mapFile } from './bands.ts'

const bin = 'vendor/loom/build'
const run = (command: string, args: string[], input: Buffer) => {
  const result = spawnSync(command, args, { input, maxBuffer: 2 ** 31 })
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`)
  process.stderr.write(result.stderr.toString().split('\n').filter((l) => !/^\s*\[/.test(l)).join('\n'))
  return result.stdout
}

let graph = readFileSync('out/gb.topo.json')
for (const [i, band] of BANDS.entries()) {
  const started = Date.now()
  if (i) {
    const d = band.merge * MERCATOR_METRES
    // Tracks sampled in proportion, so far-out bands don't compare every 5 m,
    // turn restrictions only looked for near junctions (by default as far as
    // -d), and smoothed only up close (where it shows): each takes many
    // minutes far out otherwise
    graph = run(`${bin}/topo`, ['-d', String(d), '--smooth', String(d < 1000 ? d / 3 : 0), '--sample-dist', String(Math.max(5, d / 30)),
      '--infer-restr-max-dist', '150',
      '--turn-restr-full-turn-angle', '60', '--turn-restr-full-turn-pen', '10000'], graph)
  }
  writeFileSync('out/gb.band.json', graph)
  graph = run('node', ['src/tidy.ts', 'out/gb.band.json', String(band.tidy)], Buffer.alloc(0))
  writeFileSync(mapFile(band), run(`${bin}/loom`, [], graph))
  console.error(`  zoom ${band.minZoom}+: ${band.merge} m, ${Math.round((Date.now() - started) / 1000)}s`)
}
