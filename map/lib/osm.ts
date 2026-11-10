// Reading OpenStreetMap extracts with osmium (`brew install osmium-tool`).

import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type LatLon = [number, number]

export interface Element {
  type: 'n' | 'w' | 'r'
  id: number
  tags: Record<string, string>

  /** A node's position. */
  at?: LatLon

  /** A way's nodes. */
  nodes?: number[]

  /** A relation's members, in order. */
  members?: { type: string; id: number; role: string }[]
}

function run(cmd: string, args: string[]) {
  const result = spawnSync(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'] })

  if (result.error) throw new Error(`${cmd} failed: ${result.error.message} (is osmium installed?)`)
  if (result.status !== 0) throw new Error(`${cmd} ${args[0]} exited with ${result.status}`)
}

/** OPL escapes special characters as %hex%. */
const unescape = (value: string) => value.replace(/%([0-9a-f]+)%/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))

function parseTags(field: string | undefined): Record<string, string> {
  const tags: Record<string, string> = {}
  if (!field || field.length <= 1) return tags

  for (const pair of field.slice(1).split(',')) {
    const eq = pair.indexOf('=')

    if (eq > 0) tags[unescape(pair.slice(0, eq))] = unescape(pair.slice(eq + 1))
  }

  return tags
}

/** The elements of an extract matching osmium tags-filter expressions
 *  (`w/railway=rail`), with the nodes and ways they use: nodes, then ways,
 *  then relations. */
export async function* filtered(pbf: string, expressions: string[]): AsyncGenerator<Element> {
  const work = mkdtempSync(join(tmpdir(), 'osm-'))

  try {
    const out = join(work, 'filtered.osm.pbf')

    run('osmium', ['tags-filter', pbf, ...expressions, '-o', out, '--overwrite'])

    const opl = spawn('osmium', ['cat', out, '-f', 'opl,add_metadata=false'])

    for await (const line of createInterface({ input: opl.stdout })) {
      const fields = line.split(' ')
      const field = (key: string) => fields.find((f) => f[0] === key)
      const element: Element = { type: fields[0][0] as Element['type'], id: Number(fields[0].slice(1)), tags: parseTags(field('T')) }

      if (element.type === 'n') {
        const x = field('x'), y = field('y')

        if (x && y && x.length > 1) element.at = [Number(y.slice(1)), Number(x.slice(1))]
      } else if (element.type === 'w') {
        const refs = field('N')

        element.nodes = refs && refs.length > 1 ? refs.slice(1).split(',').map((r) => Number(r.slice(1))) : []
      } else {
        // w123@role,n456@role,…
        const members = field('M')

        element.members = members && members.length > 1 ? members.slice(1).split(',').map((m) => {
          const at = m.indexOf('@')

          return { type: m[0], id: Number(m.slice(1, at)), role: unescape(m.slice(at + 1)) }
        }) : []
      }

      yield element
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** Northern Ireland isn't on National Rail. The latitude limit keeps the
 *  West Highland lines (Oban, Mallaig, Kyle), which are as far west. */
export function inNorthernIreland([lat, lon]: LatLon): boolean {
  return lon < -5.45 && lat > 54.0 && lat < 55.4
}
