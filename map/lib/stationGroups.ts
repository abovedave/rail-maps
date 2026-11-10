// Which station each stop is: groups the stops routes call at into
// stations, by their CRS codes (`ref:crs`, National Rail's three-letter
// station codes), rather than by name and distance.
//
// A stop's codes are its own, its stop area's (`public_transport=stop_area`
// relations, and the stations in them), or else the nearest station's with
// a code: of its name within SAME_NAME, or any within ANY_NAME (stops with
// no name, or a misspelt one). Codes for one station are grouped: those
// given to one stop (the Elizabeth line's own codes beside the main
// station's, Paddington's PDX and PAD), and those of stops with the same
// name close together (St Pancras's STP and SPL). Stops with no code (the
// Tyne and Wear Metro's) are grouped by name.

import { metres } from './geo.ts'
import type { LatLon } from './osm.ts'

/** How far a stop can be from the station whose code it's given: one of
 *  its name, or any. Also how close stops of a name are to be one station. */
const SAME_NAME = 1000
const ANY_NAME = 200

export interface Stop { id: number; name?: string; at: LatLon }

/** A node with a CRS code: a station. */
export interface CodedStation { crs: string; name?: string; at: LatLon }
export interface StopArea { crs?: string; members: number[] }

/** A stop's station: a key the same for all its stops, and its name. */
export interface StationOf { key: string; name: string }

export function stationGroups(stops: Stop[], stations: Map<number, CodedStation>, areas: StopArea[]): Map<number, StationOf> {
  // Each stop area's codes, by its member nodes
  const areaCodes = new Map<number, string[]>()

  for (const area of areas) {
    const codes = [area.crs, ...area.members.map((m) => stations.get(m)?.crs)].filter((c) => c !== undefined)

    for (const m of area.members) areaCodes.set(m, [...(areaCodes.get(m) ?? []), ...codes])
  }

  const coded = [...stations.values()]

  const nearest = (stop: Stop, within: number, sameName: boolean) => {
    let best: CodedStation | undefined, bestDistance = within

    for (const s of coded) {
      if (sameName && s.name !== stop.name) continue

      const d = metres(s.at, stop.at)

      if (d < bestDistance) [best, bestDistance] = [s, d]
    }

    return best?.crs
  }

  const codesOf = new Map<number, string[]>()

  for (const stop of stops) {
    const own = [stations.get(stop.id)?.crs, ...(areaCodes.get(stop.id) ?? [])].filter((c) => c !== undefined)
    const found = own.length ? own : [(stop.name && nearest(stop, SAME_NAME, true)) || nearest(stop, ANY_NAME, false)].filter((c) => c !== undefined)

    if (found.length) codesOf.set(stop.id, [...new Set(found)])
  }

  // Codes of one station, joined
  const parent = new Map<string, string>()
  const root = (c: string): string => { const p = parent.get(c) ?? c; return p === c ? c : root(p) }
  const unite = (a: string, b: string) => { const [x, y] = [root(a), root(b)]; if (x !== y) parent.set(y, x) }

  for (const codes of codesOf.values()) for (const c of codes.slice(1)) unite(codes[0], c)

  const byName = new Map<string, Stop[]>()

  for (const stop of stops) if (stop.name && codesOf.has(stop.id)) byName.set(stop.name, [...(byName.get(stop.name) ?? []), stop])

  for (const named of byName.values()) {
    for (const [i, a] of named.entries()) for (const b of named.slice(i + 1)) {
      if (metres(a.at, b.at) < SAME_NAME) unite(codesOf.get(a.id)![0], codesOf.get(b.id)![0])
    }
  }

  // Each station's key is its code with the most stops, and its name that
  // code's station's
  const stopsWith = new Map<string, number>()

  for (const codes of codesOf.values()) for (const c of codes) stopsWith.set(c, (stopsWith.get(c) ?? 0) + 1)

  const nameOf = new Map(coded.filter((s) => s.name).map((s) => [s.crs, s.name!]))
  const members = new Map<string, string[]>()

  for (const c of stopsWith.keys()) members.set(root(c), [...(members.get(root(c)) ?? []), c])

  const station = new Map<string, StationOf>()

  for (const codes of members.values()) {
    codes.sort((a, b) => stopsWith.get(b)! - stopsWith.get(a)! || a.localeCompare(b))

    const key = codes[0]
    const name = codes.map((c) => nameOf.get(c)).find((n) => n !== undefined)

    for (const c of codes) station.set(c, { key, name: name ?? key })
  }

  const result = new Map<number, StationOf>()

  for (const stop of stops) {
    const codes = codesOf.get(stop.id)

    if (codes) result.set(stop.id, station.get(codes[0])!)
    else if (stop.name) result.set(stop.id, { key: `name:${stop.name}`, name: stop.name })
  }

  return result
}
